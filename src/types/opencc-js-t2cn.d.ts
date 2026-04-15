declare module 'opencc-js/t2cn' {
  export const Locale: {
    from: {
      hk: unknown[];
      tw: unknown[];
      twp: unknown[];
    };
    to: {
      cn: unknown[];
    };
  };

  export function ConverterFactory(
    ...dictGroups: unknown[][]
  ): (input: string) => string;
}
