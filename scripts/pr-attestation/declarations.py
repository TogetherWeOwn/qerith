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


def descendants(root):
    pending = [root]
    while pending:
        node = pending.pop()
        yield node
        pending.extend(reversed(node.named_children))


def tokens(root):
    pending = [root]
    result = []
    while pending:
        node = pending.pop()
        if node.type in {"comment", "line_comment", "block_comment"}:
            continue
        if node.child_count:
            pending.extend(reversed(node.children))
        else:
            result.append(node.text)
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


def js_loop_values(call, name):
    """Resolve literal loop rows, including the tuple cases used by node:test."""
    for parent in ancestors(call):
        if parent.type != "for_in_statement":
            continue
        left = parent.child_by_field_name("left")
        right = parent.child_by_field_name("right")
        operator = parent.child_by_field_name("operator")
        if text(operator) != "of" or right.type != "array" or parent.child_by_field_name("kind").type != "const":
            continue
        if left.type == "identifier" and text(left) == name:
            rows = [(row, row) for row in right.named_children]
        elif left.type == "array_pattern" and name in [text(item) for item in left.named_children]:
            index = [text(item) for item in left.named_children].index(name)
            rows = [(row.named_children[index], row) for row in right.named_children
                    if row.type == "array" and row.named_child_count > index]
        else:
            continue
        return [(js_text(text(value)[1:-1]), tokens(row)) for value, row in rows
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
        fingerprint = tokens(node)
        if title.type == "string":
            yield js_text(text(title)[1:-1]), fingerprint
        elif title.type == "template_string":
            parts = [child for child in title.named_children if child.type == "template_substitution"]
            yield js_text(text(title)[1:-1]), fingerprint
            if len(parts) == 1 and parts[0].named_child_count == 1 and parts[0].named_children[0].type == "identifier":
                part = parts[0]
                prefix = title.text[1:part.start_byte - title.start_byte].decode()
                suffix = title.text[part.end_byte - title.start_byte:-1].decode()
                for value, row in js_loop_values(node, text(part.named_children[0])):
                    yield js_text(prefix) + value + js_text(suffix), (fingerprint, row)


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
            fingerprint = (tuple(tokens(attr) for attr in reversed(attrs)), tokens(node))
            yield name, fingerprint
            modules = [text(parent.child_by_field_name("name")) for parent in ancestors(node)
                       if parent.type == "mod_item"]
            if modules:
                yield "::".join([*reversed(modules), name]), fingerprint


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


def scan(path, source):
    suffix = PurePosixPath(path).suffix
    if suffix == ".py":
        declarations = python_declarations(source)
    else:
        if suffix not in LANGUAGES:
            raise ValueError("unsupported language")
        root = Parser(LANGUAGES[suffix]).parse(source).root_node
        if root.has_error:
            raise ValueError("invalid source")
        declarations = rust_declarations(root) if suffix == ".rs" else js_declarations(root)
    by_name = defaultdict(list)
    for label, fingerprint in declarations:
        by_name[label].append(fingerprint)
    return by_name


def supported(path):
    suffix = PurePosixPath(path).suffix
    return suffix == ".py" or suffix in LANGUAGES
