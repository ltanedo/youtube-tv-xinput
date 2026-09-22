# Third-party notices

- **Pake 3.15.7**, Tw93 and contributors: GPL-3.0-or-later with its
  [upstream exception](licenses/Pake-LICENSE-EXCEPTION.txt). The pinned npm
  package includes its license; modified source is reproduced by
  `scripts/prepare.cjs`, `native/` and `pake-native-black-background.patch`.
  https://github.com/tw93/Pake
- **adblock-rust 0.13.3**, Brave Software and contributors: MPL-2.0;
  [license](licenses/adblock-rust-MPL-2.0.txt).
  https://github.com/brave/adblock-rust
- **uBlock Origin resources**, Raymond Hill and contributors: GPL-3.0;
  [license](licenses/uBlock-GPL-3.0.txt). The serialized bundle is distributed by
  Brave's adblock-rust repository; original implementation is in uBlock Origin.
  https://github.com/gorhill/uBlock
- **uAssets filters**, uBlock Origin contributors: GPL-3.0;
  [license](licenses/uAssets-GPL-3.0.txt). Original notices remain in the lists.
  https://github.com/uBlockOrigin/uAssets
- **Brave resource additions**, Brave Software and contributors:
  [upstream license](licenses/brave-resources.txt).
  https://github.com/brave/adblock-resources
- **EasyList**, EasyList authors/contributors: dual GPLv3+/CC BY-SA 3.0 as stated
  in `core/data/easylist.txt`; selected GPLv3+ distribution terms. Preserve the
  author and license notices in that file.
  https://easylist.to/

The existing wrapper source license does not supersede these licenses. A public
binary release must make its corresponding modified Pake/blocker source and
build recipe available under the applicable terms, alongside these notices.
