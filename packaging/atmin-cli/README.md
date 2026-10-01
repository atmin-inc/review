# atmin

One command for every atmin tool. `atmin <command> [arguments]` runs the executable
`atmin-<command>` on your PATH, so each tool installs on its own and adds its commands:

```sh
brew install atmin-inc/tap/atmin-review   # brings `atmin` along
atmin review https://github.com/OWNER/REPO/pull/123 --profile ./review-profile.json
atmin code-review-runner login
```

`atmin --help` lists the commands installed. A new atmin tool needs no change here: it ships
`atmin-<name>` executables and depends on this package or the `atmin` formula.
Tools keep their settings in `~/.config/atmin/<tool>.json`.
