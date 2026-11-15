# Screen-reader evidence (under construction)

`fixture.html` is a synthetic self-test only. It has no account, authentication,
production service or external resource. It is not evidence for any application.
No capture route is implemented or validated yet; do not use this fixture as a
substitute for actual Orca speech output.

The self-test starts its polite atomic status with neutral text as a workaround
for observed Orca 46.1 empty-status text caching. The expected announcement is
still set only by the button click. This does not establish support for initially
empty live regions; that case is currently unsupported, not a passing result.
