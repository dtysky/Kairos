Workspace-managed Resolve LUT assets live here.

- Put `.cube` files under this directory.
- Use the same relative path here that you reference in `config/color-transform-presets.json`.
- `config/color-transform-presets.json` maps `profile -> { deviceFamily/default -> Resolve LUT path }`.
- Kairos copies only missing same-path LUTs from here into the device Resolve default LUT directory during `prepare_root`.
- If a referenced LUT does not exist here, Kairos will still try to use the path as an already-installed Resolve LUT.
