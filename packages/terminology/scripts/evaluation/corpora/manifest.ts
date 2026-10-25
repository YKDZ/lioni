export type SourceFile = {
  readonly path: string;
  readonly sha256: string;
};

export type ExternalSourceManifest = {
  readonly id: "cfpa" | "kuma";
  readonly repository: string;
  readonly commit: string;
  readonly tag?: string;
  readonly files: readonly SourceFile[];
  readonly converterVersion: string;
  readonly expectedTransformedSha256: string;
  readonly license: readonly {
    readonly path: string;
    readonly spdx: string;
  }[];
};

const cfpaTermFiles = [
  {
    path: "Vanilla/terms/terms-v1.tsv",
    sha256: "8aa7e637106bcfee75b0dfdad9eb4cfe2e18105277bd2d1c2fe93c9e694b565c",
  },
  {
    path: "Vanilla/terms/special/terms-banner.tsv",
    sha256: "52c6ef63b2fa290ee2d11e1247e5c23e53cc032a6371c2371e2424e8775f00a9",
  },
  {
    path: "Vanilla/terms/special/terms-pottery.tsv",
    sha256: "a5b6eb733cbdbbd32fab32fa32ed68c74e47eb6c7d411369882e39e136f18334",
  },
  {
    path: "Vanilla/terms/special/terms-subtitles.tsv",
    sha256: "06eead334c888536801715ec343a6613fb1bd9bd6b8009c97ac9afb89446778a",
  },
  {
    path: "Vanilla/terms/special/terms-trim.tsv",
    sha256: "51df76ee38f5b8feb1165748f94c2b101750f5d7e574b0f435a5384505a16313",
  },
  {
    path: "Vanilla/terms/special/terms-tropical_fish.tsv",
    sha256: "9502a41926a6b22d6688bf256f4afbdc65492abe756c85d21767b24ea4507cf8",
  },
];

export const cfpaSource: ExternalSourceManifest = Object.freeze({
  id: "cfpa",
  repository: "https://github.com/CFPAOrg/Glossary.git",
  commit: "e27df31f1de56535aefd0f2a8ae1e8557a66c061",
  converterVersion: "lioni-cfpa-v1",
  expectedTransformedSha256:
    "0bd59ad1ca7ff5ca68f1f7da87262c0995e202631f673c01c5a877dc2b3f128a",
  files: Object.freeze([
    {
      path: "Vanilla/latest.tsv",
      sha256:
        "2099eea74c3fd6855eeedc10a384e882a12fa171dd432a6bb9512153f18b35c7",
    },
    ...cfpaTermFiles,
    {
      path: "LICENSE",
      sha256:
        "cd9832c492786274823efa8d026ba57f45b51fabf37fc67b85069e1ed0c062b7",
    },
    {
      path: "utility/LICENSE",
      sha256:
        "a1b1eb05f988650a9307a238216c127ec93bcef3dc1b5766ecc2f40e675383d1",
    },
  ]),
  license: Object.freeze([
    Object.freeze({ path: "LICENSE", spdx: "CC-BY-NC-SA-4.0" }),
    Object.freeze({ path: "utility/LICENSE", spdx: "MIT" }),
  ]),
});

export const kumaSource: ExternalSourceManifest = Object.freeze({
  id: "kuma",
  repository: "https://github.com/louislam/uptime-kuma.git",
  commit: "d54e4619e52553416e292549f435cc7e57330c29",
  tag: "2.5.7",
  converterVersion: "lioni-kuma-v1",
  expectedTransformedSha256:
    "ba62e2f41d2de567176a6d862e0b7a0dc949c39869e180bcc90e12ddf0180bca",
  files: Object.freeze([
    {
      path: "src/lang/en.json",
      sha256:
        "ad9a8a190814a5575aad48465cb188c2473daff719ab55390c01063896394872",
    },
    {
      path: "src/lang/zh-CN.json",
      sha256:
        "b20a115ade12f06ccbf77f6e0bf76c99df4e4defaafcf1e06314962148978181",
    },
    {
      path: "src/lang/zh-TW.json",
      sha256:
        "5b75ff92bafadfc1316377ccff0256a5f1bbe90da260414c7b98f0ab8395d0cb",
    },
    {
      path: "src/lang/ja.json",
      sha256:
        "822212ed55221ef870287f8620ab3381d04ea1bf7b81dd55edcbd8f69614bf4b",
    },
    {
      path: "LICENSE",
      sha256:
        "a0e4fe6bed45a817794411c8ddf2deffbe010ac3a2b2f47e5b8d2fe2f9486883",
    },
  ]),
  license: Object.freeze([Object.freeze({ path: "LICENSE", spdx: "MIT" })]),
});

export const sourceManifests = Object.freeze({
  cfpa: cfpaSource,
  kuma: kumaSource,
});

export const cfpaSelections = Object.freeze({
  text: Object.freeze({
    columns: Object.freeze({ en: "en_us", "zh-CN": "zh_cn", ja: "ja_jp" }),
    emptyValues: "retain as empty entries; do not use English fallback",
    encodedNewline:
      "decode literal \\n as a newline per the upstream snapshot workflow",
  }),
  referenceTerms: Object.freeze({
    files: Object.freeze(cfpaTermFiles.map(({ path }) => path)),
    rowIdentity:
      "file path + one-based source row; no cross-file concept merge",
    expressionPolicy:
      "English and Chinese variants map to allowed for exploratory coverage only",
    variantSeparator: "|",
  }),
});

export const kumaSelections = Object.freeze({
  locales: Object.freeze({
    en: "src/lang/en.json",
    "zh-CN": "src/lang/zh-CN.json",
    "zh-TW": "src/lang/zh-TW.json",
    ja: "src/lang/ja.json",
  }),
  textPolicy:
    "preserve exact string values; no i18n interpolation parsing or English fallback",
});

export const contentTypeSelection = Object.freeze({
  cfpa: Object.freeze({
    ui: Object.freeze([
      "gui.done",
      "gui.cancel",
      "gui.back",
      "menu.options",
      "menu.singleplayer",
      "menu.multiplayer",
      "menu.quit",
      "options.title",
      "options.language",
      "selectWorld.create",
      "selectWorld.delete",
    ]),
    paragraph: Object.freeze([
      "mco.account.privacyinfo",
      "menu.custom_screen_info.contents",
      "outOfMemory.message",
      "telemetry.event.p2p_connection.description",
      "optimizeWorld.confirm.description",
    ]),
  }),
  kuma: Object.freeze({
    ui: Object.freeze([
      "Settings",
      "Save",
      "Cancel",
      "Delete",
      "Dashboard",
      "About",
      "Pause",
      "Resume",
      "Close",
      "Login",
      "Logout",
      "Confirm",
      "Language",
    ]),
    paragraph: Object.freeze([
      "homeAssistantNotificationActionHelptext",
      "GlobalpingLocationDescription",
      "matrixDesc2",
      "jsonQueryDescription",
      "GlobalpingMonitorDescription",
    ]),
  }),
});
