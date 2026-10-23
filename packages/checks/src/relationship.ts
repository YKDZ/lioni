import type {
  Awaitable,
  QualityCheckDefinition,
  QualityCheckInput,
  QualityEvidence,
  QualityLocation,
  QualityObject,
  QualityRelationship,
  QualitySubject,
  TranslationUnitInput,
  SourceUnitFact,
} from "@l10n/core";

export type RelationshipMemberEvidence<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly subject: QualitySubject;
  readonly sourceUnit: SourceUnitFact<TUnit>;
  readonly translation: TTranslation;
  readonly sourceLocation: QualityLocation;
  readonly translationLocation: QualityLocation;
};

export type RelationshipViolation = {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly location?: QualityLocation;
  readonly evidence?: readonly QualityEvidence[];
};

export type RelationshipEvaluationInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfiguration,
> = {
  readonly relationship: QualityRelationship;
  readonly members: readonly RelationshipMemberEvidence<TUnit, TTranslation>[];
  readonly configuration: TConfiguration;
};

export type RelationshipCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfiguration,
> = {
  readonly id: string;
  readonly relationshipKind: string;
  readonly configuration: TConfiguration;
  readonly translationLocation?: (
    translation: TTranslation,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation;
  readonly evaluate: (
    input: RelationshipEvaluationInput<TUnit, TTranslation, TConfiguration>,
  ) => Awaitable<RelationshipViolation | undefined>;
};

type RelationshipResult = {
  readonly status: "complete" | "not-applicable" | "incomplete" | "failed";
  readonly findings: readonly {
    readonly severity: "error" | "warning" | "info";
    readonly object: QualityObject;
    readonly location: QualityLocation;
    readonly message: string;
    readonly evidence: readonly QualityEvidence[];
  }[];
  readonly issue?: {
    readonly code: string;
    readonly message: string;
    readonly object: QualityObject;
    readonly location?: QualityLocation;
  };
};

export function createRelationshipChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfiguration,
>(
  options: RelationshipCheckerOptions<TUnit, TTranslation, TConfiguration>,
): QualityCheckDefinition<TUnit, TTranslation> {
  return {
    id: options.id,
    configuration: options.configuration,
    async check(input) {
      const subjects = input.subjects;
      const relationships = (input.relationships ?? []).filter(
        (relationship) =>
          relationship.kind === options.relationshipKind &&
          relationship.members.some((member) =>
            subjects.some((subject) => sameSubject(member, subject)),
          ),
      );
      const results: RelationshipResult[] = [];
      for (const relationship of relationships) {
        const members = await resolveMembers(
          input,
          relationship,
          options.translationLocation,
        );
        if ("status" in members) {
          results.push(members);
          continue;
        }

        const firstMember = members.members[0];
        if (firstMember === undefined) {
          results.push({
            status: "failed",
            findings: [],
            issue: {
              code: "relationshipHasNoMembers",
              message: "关系没有可供检查的成员。",
              object: relationshipObject(relationship),
            },
          });
          continue;
        }
        const violation = await options.evaluate({
          relationship,
          members: members.members,
          configuration: input.configuration as TConfiguration,
        });
        results.push({
          status: "complete",
          findings:
            violation === undefined
              ? []
              : [
                  {
                    severity: violation.severity,
                    object: relationshipObject(relationship),
                    location:
                      violation.location ?? firstMember.translationLocation,
                    message: violation.message,
                    evidence:
                      violation.evidence ??
                      members.members.map((member, index) =>
                        targetEvidence(
                          member,
                          index === 0 ? "target" : "related",
                        ),
                      ),
                  },
                ],
        });
      }

      const coverage = {
        selected: relationships.length,
        evaluated: results.filter(({ status }) => status === "complete").length,
        notApplicable: results.filter(
          ({ status }) => status === "not-applicable",
        ).length,
        incomplete: results.filter(({ status }) => status === "incomplete")
          .length,
        failed: results.filter(({ status }) => status === "failed").length,
      };
      return {
        status:
          coverage.failed > 0
            ? "failed"
            : coverage.incomplete > 0
              ? "incomplete"
              : coverage.evaluated > 0
                ? "complete"
                : "not-applicable",
        diagnostics: results.flatMap(({ findings }) => findings),
        issues: results.flatMap(({ issue }) =>
          issue === undefined ? [] : [issue],
        ),
        coverage,
      };
    },
  };
}

async function resolveMembers<TUnit extends TranslationUnitInput, TTranslation>(
  input: QualityCheckInput<TUnit, TTranslation>,
  relationship: QualityRelationship,
  translationLocation?: (
    translation: TTranslation,
    subject: QualitySubject,
    defaultLocation: QualityLocation,
  ) => QualityLocation,
): Promise<
  | {
      readonly members: readonly RelationshipMemberEvidence<
        TUnit,
        TTranslation
      >[];
    }
  | RelationshipResult
> {
  const object = relationshipObject(relationship);
  const members: RelationshipMemberEvidence<TUnit, TTranslation>[] = [];
  for (const subject of relationship.members) {
    if (!allowsEvidence(input, subject))
      return {
        status: "incomplete",
        findings: [],
        issue: {
          code: "relationshipEvidenceOutOfScope",
          message: "证据范围未包含关系的全部成员。",
          object,
        },
      };

    const sourceUnit = input.facts.source.units.find(
      ({ key }) => key === subject.key,
    );
    if (sourceUnit === undefined) {
      const sourceReadFailed = input.facts.source.read.status === "failed";
      const sourceReadComplete = input.facts.source.read.status === "complete";
      return {
        status:
          sourceReadFailed || sourceReadComplete ? "failed" : "incomplete",
        findings: [],
        issue: {
          code: sourceReadFailed
            ? "relationshipSourceReadFailed"
            : sourceReadComplete
              ? "relationshipSourceMissing"
              : "relationshipSourceUnknown",
          message: sourceReadFailed
            ? "原文读取失败，无法定位关系成员。"
            : sourceReadComplete
              ? "关系引用的原文单元不存在。"
              : "原文读取范围不足，无法定位关系成员。",
          object,
        },
      };
    }
    if (sourceUnit.bodyAvailability !== "available")
      return {
        status: "incomplete",
        findings: [],
        issue: {
          code: "relationshipSourceUnavailable",
          message: "关系成员的原文内容不可用。",
          object,
        },
      };

    const languageRead = input.facts.translations.reads.find(
      ({ language }) => language === subject.language,
    );
    if (languageRead === undefined)
      return {
        status: "not-applicable",
        findings: [],
        issue: {
          code: "relationshipLanguageNotRead",
          message: "关系成员的目标语言没有读取事实。",
          object,
        },
      };

    const association = input.facts.associations.find(
      ({ sourceKey, language }) =>
        sourceKey === subject.key && language === subject.language,
    );
    if (association === undefined)
      return {
        status: "incomplete",
        findings: [],
        issue: {
          code: "relationshipAssociationMissing",
          message: "关系成员没有源译关联事实。",
          object,
        },
      };
    if (association.status === "missing")
      return {
        status: "not-applicable",
        findings: [],
        issue: {
          code: "relationshipTranslationMissing",
          message: "关系成员没有可检查的实际译文。",
          object,
        },
      };
    if (association.status === "unknown")
      return {
        status:
          association.coverageStatus === "failed" ? "failed" : "incomplete",
        findings: [],
        issue: {
          code: "relationshipAssociationUnknown",
          message: "读取证据不足，无法确定关系成员的实际译文。",
          object,
        },
      };
    if (association.status === "conflict")
      return {
        status: "incomplete",
        findings: [],
        issue: {
          code: "relationshipTranslationConflict",
          message: "关系成员匹配到多个实际译文。",
          object,
        },
      };
    if (association.status === "unavailable")
      return {
        status: "incomplete",
        findings: [],
        issue: {
          code: "relationshipTranslationUnavailable",
          message: "关系成员的译文正文不可用。",
          object,
        },
      };

    const translation = input.facts.translations.records.find(
      ({ index }) => index === association.translationIndexes[0],
    );
    if (translation === undefined)
      return {
        status: "failed",
        findings: [],
        issue: {
          code: "relationshipTranslationFactMissing",
          message: "源译关联指向不存在的译文记录。",
          object,
        },
      };
    if (translation.bodyAvailability !== "available")
      return {
        status: "incomplete",
        findings: [],
        issue: {
          code: "relationshipTranslationUnavailable",
          message: "关系成员的译文正文不可用。",
          object,
        },
      };

    const defaultTranslationLocation: QualityLocation = {
      language: subject.language,
      range: translation.range,
    };
    members.push({
      subject,
      sourceUnit,
      translation: translation.translation,
      sourceLocation: {
        language: null,
        range: input.facts.source.read.scopes[sourceUnit.scopeIndex]?.range,
      },
      translationLocation:
        translationLocation?.(
          translation.translation,
          subject,
          defaultTranslationLocation,
        ) ?? defaultTranslationLocation,
    });
  }
  return { members };
}

function allowsEvidence<TUnit extends TranslationUnitInput, TTranslation>(
  input: QualityCheckInput<TUnit, TTranslation>,
  subject: QualitySubject,
): boolean {
  return input.evidenceScope.some(
    ({ kind, key, language }) =>
      kind === "translation-unit" &&
      key === subject.key &&
      (language === undefined || language === subject.language),
  );
}

function sameSubject(left: QualitySubject, right: QualitySubject): boolean {
  return left.key === right.key && left.language === right.language;
}

function relationshipObject(relationship: QualityRelationship): QualityObject {
  return {
    kind: "relationship",
    key: relationship.key,
    relationshipKind: relationship.kind,
    members: relationship.members.map((member) => ({ ...member })),
  };
}

function targetEvidence<TUnit extends TranslationUnitInput, TTranslation>(
  member: RelationshipMemberEvidence<TUnit, TTranslation>,
  role: string,
): QualityEvidence {
  return {
    role,
    object: {
      kind: "translation-unit",
      key: member.subject.key,
      language: member.subject.language,
    },
    location: member.translationLocation,
    value: member.translation,
  };
}
