"""Static test declarations. Source bytes are parsed and never imported."""

import ast
from collections import defaultdict
from pathlib import PurePosixPath
import re

from tree_sitter import Language, Parser
import tree_sitter_javascript
import tree_sitter_rust
import tree_sitter_typescript


JS = Language(tree_sitter_javascript.language())
TS = Language(tree_sitter_typescript.language_typescript())
TSX = Language(tree_sitter_typescript.language_tsx())
RUST = Language(tree_sitter_rust.language())
LANGUAGES = {".js": JS, ".mjs": JS, ".cjs": JS, ".ts": TS, ".mts": TS, ".cts": TS,
             ".tsx": TSX, ".jsx": JS, ".rs": RUST}
RUST_TEST = re.compile(rb"#\[\s*(?:tokio\s*::\s*)?test(?:\s*\(.*\))?\s*\]", re.S)
JS_ESCAPE = re.compile(r"\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])")
FUNCTIONS = {"arrow_function", "function_declaration", "function_expression", "generator_function",
             "generator_function_declaration", "method_definition"}
BINDING_FIELDS = {"assignment_pattern": "left", "object_assignment_pattern": "left", "pair_pattern": "value",
                  "required_parameter": "pattern", "optional_parameter": "pattern"}


def descendants(root):
    pending = [root]
    while pending:
        node = pending.pop()
        yield node
        pending.extend(reversed(node.named_children))


def fingerprint(root):
    # Preserve statement boundaries as well as tokens. JavaScript can change
    # its parse tree when a newline is moved without changing leaf tokens.
    pending = [root]
    result = []
    while pending:
        node = pending.pop()
        if node is None:
            result.append(None)
            continue
        if node.type in {"comment", "line_comment", "block_comment"}:
            continue
        if node.child_count:
            result.append(node.type)
            pending.append(None)
            pending.extend(reversed(node.children))
        else:
            result.append((node.type, node.text))
    return tuple(result)


def text(node):
    return node.text.decode() if node is not None else ""


def js_text(value):
    def decode(match):
        code = match[0][1:]
        if code.startswith("u{"):
            return chr(int(code[2:-1], 16))
        if len(code) > 1 and code[0] in "ux":
            return chr(int(code[1:], 16))
        return {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v",
                "0": "\0", "\n": "", "\r": "", "\r\n": ""}.get(code, code)

    return JS_ESCAPE.sub(decode, value).encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def js_bindings(root):
    bindings = {}
    for node in root.named_children:
        if node.type != "import_statement":
            continue
        source = text(node.child_by_field_name("source"))[1:-1]
        if source not in {"node:test", "vitest", "@playwright/test"}:
            continue
        clause = next((child for child in node.named_children if child.type == "import_clause"), None)
        if clause is None:
            continue
        for child in clause.named_children:
            if child.type == "identifier" and source == "node:test":
                bindings[text(child)] = source
            if child.type == "named_imports":
                for member in child.named_children:
                    name = member.child_by_field_name("name")
                    if text(name) in {"it", "test"}:
                        bindings[text(member.child_by_field_name("alias") or name)] = source
    for node in root.named_children:
        if node.type != "lexical_declaration" or text(node.child_by_field_name("kind")) != "const":
            continue
        for declaration in node.named_children:
            name = declaration.child_by_field_name("name")
            value = declaration.child_by_field_name("value")
            if name is None or name.type != "identifier" or value is None:
                continue
            if value.type == "ternary_expression" and text(value.child_by_field_name("condition")) == "import.meta.main":
                value = value.child_by_field_name("consequence")
            if value.type == "identifier" and text(value) in bindings:
                bindings[text(name)] = bindings[text(value)]
    return bindings


def tuple_items(node):
    index = 0
    for child in node.children:
        if child.type == ",":
            index += 1
        elif child.type in {"rest_pattern", "spread_element"}:
            break
        elif child.is_named and child.type != "comment":
            yield index, child


def binds(pattern, name):
    if pattern is None:
        return False
    if pattern.type in {"identifier", "shorthand_property_identifier_pattern"}:
        return text(pattern) == name
    if pattern.type in BINDING_FIELDS:
        return binds(pattern.child_by_field_name(BINDING_FIELDS[pattern.type]), name)
    if pattern.type in {"array_pattern", "object_pattern", "formal_parameters", "rest_pattern"}:
        return any(binds(child, name) for child in pattern.named_children)
    return False


def declares(statement, name):
    if statement is None:
        return False
    if statement.type in {"function_declaration", "generator_function_declaration", "class_declaration"}:
        return text(statement.child_by_field_name("name")) == name
    if statement.type in {"lexical_declaration", "variable_declaration"}:
        return any(binds(binding.child_by_field_name("name"), name) for binding in statement.named_children)
    return False


def hoists_var(body, name):
    pending = [body] if body is not None else []
    while pending:
        node = pending.pop()
        if node.type in FUNCTIONS or node.type == "class_static_block":
            continue
        if node.type == "variable_declaration" and declares(node, name):
            return True
        if (node.type == "for_in_statement" and text(node.child_by_field_name("kind")) == "var"
                and binds(node.child_by_field_name("left"), name)):
            return True
        pending.extend(node.named_children)
    return False


def shadows(scope, name):
    if any(binds(scope.child_by_field_name(field), name) for field in ("parameters", "parameter")):
        return True
    if scope.type in FUNCTIONS:
        return (text(scope.child_by_field_name("name")) == name
                or hoists_var(scope.child_by_field_name("body"), name))
    if scope.type == "class":
        return text(scope.child_by_field_name("name")) == name
    if scope.type == "statement_block":
        return any(declares(statement, name) for statement in scope.named_children)
    if scope.type == "for_statement":
        return declares(scope.child_by_field_name("initializer"), name)
    if scope.type == "switch_body":
        return any(declares(statement, name) for case in scope.named_children for statement in case.named_children)
    return False


def js_loop_values(call, name):
    """Resolve literal loop rows, including the tuple cases used by node:test."""
    for parent in ancestors(call):
        if shadows(parent, name):
            break
        if parent.type != "for_in_statement":
            continue
        left = parent.child_by_field_name("left")
        if not binds(left, name):
            continue
        right = parent.child_by_field_name("right")
        operator = parent.child_by_field_name("operator")
        while right.type in {"as_expression", "parenthesized_expression"}:
            right = next(child for child in right.named_children if child.type != "comment")
        if text(operator) != "of" or right.type != "array" or text(parent.child_by_field_name("kind")) != "const":
            break
        if left.type == "identifier" and text(left) == name:
            rows = [(row, row) for row in right.named_children]
        elif left.type == "array_pattern":
            index = next((slot for slot, binding in tuple_items(left) if text(binding) == name), None)
            if index is None:
                break
            rows = [(value, row) for row in right.named_children if row.type == "array"
                    for slot, value in tuple_items(row) if slot == index]
        else:
            break
        return [(js_text(text(value)[1:-1]), fingerprint(row)) for value, row in rows
                if value.type == "string"]
    return []


def ancestors(node):
    parent = node.parent
    while parent is not None:
        yield parent
        parent = parent.parent


def node_subtest(call, receiver, bindings):
    for parent in ancestors(call):
        args = parent.parent
        if parent.type not in {"arrow_function", "function_expression"} or args.type != "arguments":
            continue
        parameters = parent.child_by_field_name("parameters")
        parameter = parent.child_by_field_name("parameter")
        if parameters is not None and parameters.named_children:
            parameter = parameters.named_children[0]
            if parameter.type == "required_parameter":
                parameter = parameter.child_by_field_name("pattern")
        outer = args.parent
        if (text(parameter) == receiver and outer.type == "call_expression"
                and bindings.get(text(outer.child_by_field_name("function"))) == "node:test"):
            return True
    return False


def js_declarations(root):
    bindings = js_bindings(root)
    for node in descendants(root):
        if node.type != "call_expression":
            continue
        function = node.child_by_field_name("function")
        arguments = node.child_by_field_name("arguments")
        if arguments is None:
            continue
        args = [child for child in arguments.named_children if child.type != "comment"]
        if not args:
            continue
        table = None
        if function.type == "call_expression":
            table, function = function, function.child_by_field_name("function")
        name = text(function)
        if table is not None:
            if function.type != "member_expression" or text(function.child_by_field_name("property")) != "each":
                continue
            name = text(function.child_by_field_name("object"))
        if name not in bindings:
            if (table is not None or function.type != "member_expression"
                    or text(function.child_by_field_name("property")) != "test"
                    or not node_subtest(node, text(function.child_by_field_name("object")), bindings)):
                continue
        title = args[0]
        declaration = fingerprint(node)
        if title.type == "string":
            yield js_text(text(title)[1:-1]), declaration
        elif title.type == "template_string":
            parts = [child for child in title.named_children if child.type == "template_substitution"]
            yield js_text(text(title)[1:-1]), declaration
            if len(parts) == 1 and parts[0].named_child_count == 1 and parts[0].named_children[0].type == "identifier":
                part = parts[0]
                prefix = title.text[1:part.start_byte - title.start_byte].decode()
                suffix = title.text[part.end_byte - title.start_byte:-1].decode()
                for value, row in js_loop_values(node, text(part.named_children[0])):
                    yield js_text(prefix) + value + js_text(suffix), (declaration, row)


def rust_declarations(root):
    for node in descendants(root):
        if node.type != "function_item":
            continue
        preceding = node.prev_named_sibling
        attrs = []
        while preceding is not None and preceding.type in {"attribute_item", "line_comment", "block_comment"}:
            if preceding.type == "attribute_item":
                attrs.append(preceding)
            preceding = preceding.prev_named_sibling
        if any(RUST_TEST.fullmatch(attr.text) for attr in attrs):
            name = text(node.child_by_field_name("name"))
            declaration = (tuple(fingerprint(attr) for attr in reversed(attrs)), fingerprint(node))
            yield name, declaration
            modules = [text(parent.child_by_field_name("name")) for parent in ancestors(node)
                       if parent.type == "mod_item"]
            if modules:
                yield "::".join([*reversed(modules), name]), declaration


def python_declarations(source):
    for node in ast.parse(source).body:
        methods = node.body if isinstance(node, ast.ClassDef) else (node,)
        for method in methods:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith("test_"):
                continue
            fingerprint = ast.dump(method)
            yield method.name, fingerprint
            if node is not method:
                yield f"{node.name}.{method.name}", fingerprint
                yield f"{node.name}::{method.name}", fingerprint


def scan(path, source, grammar=None):
    suffix = PurePosixPath(path).suffix
    if suffix == ".py":
        declarations = python_declarations(source)
    else:
        if suffix not in LANGUAGES:
            raise ValueError("unsupported language")
        root = Parser(grammar or LANGUAGES[suffix]).parse(source).root_node
        if root.has_error:
            raise ValueError("invalid source")
        declarations = rust_declarations(root) if suffix == ".rs" else js_declarations(root)
    by_name = defaultdict(list)
    for label, fingerprint in declarations:
        by_name[label].append(fingerprint)
    return by_name


def compare(path, source, old_path, baseline, selectors=None):
    current = scan(path, source)
    if baseline is None:
        return current, {}
    head_grammar = LANGUAGES.get(PurePosixPath(path).suffix)
    base_grammar = LANGUAGES.get(PurePosixPath(old_path).suffix)
    js_grammars = {JS, TS, TSX}
    if head_grammar in js_grammars and base_grammar in js_grammars and head_grammar != base_grammar:
        # Both sides must use the same AST grammar for an extension-only rename.
        names = current.keys() if selectors is None else selectors
        for grammar in dict.fromkeys((head_grammar, TSX, base_grammar)):
            try:
                candidate = current if grammar == head_grammar else scan(path, source, grammar=grammar)
                if all(len(candidate.get(name, ())) == len(current.get(name, ())) for name in names):
                    return candidate, scan(old_path, baseline, grammar=grammar)
            except ValueError:
                continue
        raise ValueError("no common JavaScript grammar")
    return current, scan(old_path, baseline)


def supported(path):
    suffix = PurePosixPath(path).suffix
    return suffix == ".py" or suffix in LANGUAGES
