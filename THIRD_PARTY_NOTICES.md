# Third-Party Notices

## Visual Studio Code Code - OSS

- Copyright: Microsoft Corporation
- Source: https://github.com/microsoft/vscode
- Parser source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts
- License: MIT
- License text: https://github.com/microsoft/vscode/blob/main/LICENSE.txt

`kmux` adapts portions of the terminal local path parsing logic for renderer
terminal file-link detection.

## @vscode/codicons

- Copyright: Microsoft Corporation
- Source: https://github.com/microsoft/vscode-codicons
- Package: https://www.npmjs.com/package/@vscode/codicons
- License: CC-BY-4.0
- License text: https://creativecommons.org/licenses/by/4.0/

`kmux` uses the distributed Codicon font and CSS package for renderer toolbar,
sidebar, workspace-row, and tab icons. The packaged icon files are used
unmodified.

## Nerd Fonts Symbols

- Copyright: Ryan L McIntyre and Nerd Fonts contributors
- Source: https://github.com/ryanoasis/nerd-fonts
- Release asset: https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/NerdFontsSymbolsOnly.zip
- License: Nerd Fonts patched fonts and source fonts are distributed under the SIL Open Font License 1.1 with additional upstream glyph-set licenses; see upstream `LICENSE` and `license-audit.md`
- License text: https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/LICENSE

`kmux` vendors the official `SymbolsNerdFontMono-Regular.ttf` asset from the
Nerd Fonts `SymbolsOnly` release, converted to WOFF2 for renderer bundling, as
a built-in terminal glyph fallback so Powerline separators and Nerd Font icons
render on new installs without manual font setup.

## JetBrainsMono Nerd Font Mono

- Copyright: The JetBrains Mono Project Authors
- Source: https://github.com/ryanoasis/nerd-fonts
- Release asset: https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/JetBrainsMono.tar.xz
- License: SIL Open Font License 1.1
- License text: apps/desktop/src/renderer/src/assets/JetBrainsMonoNerdFontMono-OFL.txt

`kmux` vendors the official Nerd Fonts `JetBrainsMonoNerdFontMono` Regular,
Bold, Italic, and Bold Italic faces from the v3.4.0 release, converted to
WOFF2 for renderer bundling, as the default terminal text font.
