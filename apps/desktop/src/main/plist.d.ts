declare module "plist" {
  const plist: {
    parse(value: string): unknown;
    build(value: unknown): string;
  };

  export default plist;
}
