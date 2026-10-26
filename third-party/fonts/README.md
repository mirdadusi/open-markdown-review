# Offline PDF font inputs

These unmodified, SIL Open Font License 1.1 font files are build inputs. PDF exports embed font subsets; the generated review HTML contains the fonts needed at runtime and never downloads fonts or uses an operating-system font as authoritative PDF text.

| File | Upstream | SHA-256 |
| --- | --- | --- |
| `NotoSansSymbols2-Regular.ttf` | [Google Fonts / Noto Sans Symbols 2](https://github.com/google/fonts/tree/main/ofl/notosanssymbols2) | `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21` |
| `NotoSansMono-Regular.ttf` | [Noto Fonts / static Noto Sans Mono](https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSansMono) | `d9e2b23d19f8230be7146f409a52b1d23117e635e28f2e2892cf91b7382f325b` |

License and copyright notices are retained in `../NOTO-SYMBOLS.txt` and `../NOTO-MONO.txt` and included in client dependency notices. Roboto inputs are supplied by the pinned pdfmake package with `../ROBOTO.txt`. `scripts/build-pdf-fonts.mjs` derives glyph coverage, advance metrics and compressed runtime virtual-filesystem data from the exact checked-in bytes. Fonts are expanded and digest-checked once on the first export, not when a review is opened. Updating a font requires updating this inventory and re-running PDF qualification.
