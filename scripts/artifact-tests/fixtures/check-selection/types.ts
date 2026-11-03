import {
  analyzeQuality,
  createMessageFamilyChecker,
  createTermChecker,
  requireAllowedTranslation,
  type MessageFamilyCheckerOptions,
  type QualityCheckDefinition,
  type QualityObject,
  type TermCheckerOptions,
} from "@lioni/lioni";

import config from "./lioni.config.ts";

const selectedById = analyzeQuality(config, { checkIds: ["syntax"] });
const selectedByGroups = analyzeQuality(config, {
  groups: ["daily", "syntaxOnly"],
});
void selectedById;
void selectedByGroups;

// @ts-expect-error 发行声明应拒绝未配置的检查项 ID。
analyzeQuality(config, { checkIds: ["missing"] });
// @ts-expect-error 发行声明应拒绝未配置的组名。
analyzeQuality(config, { groups: ["all"] });
// @ts-expect-error ID 与分组选择不能同时提供。
analyzeQuality(config, { checkIds: ["syntax"], groups: ["daily"] });

type Body = { readonly text: string; readonly state: "draft" | "reviewed" };
type Unit = {
  readonly source: Body;
  readonly context: { readonly key: string };
};
type Translation = { readonly id: string; readonly body: Body };
type Subject = { readonly sourceText: string };

declare const optionalFamilyIdOptions: MessageFamilyCheckerOptions<
  Unit,
  Translation,
  Unit,
  Body
>;
const dynamicFamily = createMessageFamilyChecker(optionalFamilyIdOptions);
const dynamicFamilyId: string = dynamicFamily.id;
const dynamicFamilyContext: QualityCheckDefinition<
  Unit,
  Translation,
  QualityObject,
  Body,
  never,
  string
> = dynamicFamily;
void dynamicFamilyId;
void dynamicFamilyContext;

declare const familyOptionsWithoutId: Omit<
  MessageFamilyCheckerOptions<Unit, Translation, Unit, Body>,
  "id"
>;
const defaultFamily = createMessageFamilyChecker(familyOptionsWithoutId);
const defaultFamilyId: "message-family-consistency" = defaultFamily.id;
const literalFamily = createMessageFamilyChecker({
  ...optionalFamilyIdOptions,
  id: "host/message-family",
});
const literalFamilyId: "host/message-family" = literalFamily.id;
void defaultFamilyId;
void literalFamilyId;

declare const optionalTermIdOptions: TermCheckerOptions<
  Unit,
  Translation,
  Subject,
  Body,
  never,
  string | undefined
>;
const dynamicTerm = createTermChecker.withTypes<
  Unit,
  Translation,
  Subject,
  Body
>()(optionalTermIdOptions);
const dynamicTermId: string = dynamicTerm.id;
const dynamicTermContext: QualityCheckDefinition<
  Unit,
  Translation,
  QualityObject,
  Body,
  never,
  string
> = dynamicTerm;
const directDynamicTerm = createTermChecker(optionalTermIdOptions);
const directDynamicTermId: string = directDynamicTerm.id;
const literalTerm = createTermChecker.withTypes<
  Unit,
  Translation,
  Subject,
  Body
>()({ ...optionalTermIdOptions, id: "host/term" });
const literalTermId: "host/term" = literalTerm.id;
const derivedTerm = createTermChecker.withTypes<
  Unit,
  Translation,
  Subject,
  Body
>()({
  ...optionalTermIdOptions,
  id: undefined,
  rule: requireAllowedTranslation(),
});
const derivedTermId: "terminology/require-allowed-translation" = derivedTerm.id;
void dynamicTermId;
void dynamicTermContext;
void directDynamicTermId;
void literalTermId;
void derivedTermId;
