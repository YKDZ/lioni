export type VueI18nUsage = {
  readonly key: string;
  readonly file: string;
  readonly kind: "call" | "component";
  readonly supplied: readonly string[];
  readonly parametersKnown: boolean;
};

export type VueI18nUsageIndex = {
  readonly entries: readonly VueI18nUsage[];
  readonly unresolved: readonly {
    readonly file: string;
    readonly expression: string;
  }[];
  readonly errors: readonly {
    readonly file: string;
    readonly message: string;
  }[];
};
