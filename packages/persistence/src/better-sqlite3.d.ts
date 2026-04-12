declare module "better-sqlite3" {
  interface Statement<Result = unknown> {
    get(...params: unknown[]): Result | undefined;
    run(params?: unknown): unknown;
  }

  interface Database {
    pragma(source: string): unknown;
    exec(source: string): this;
    prepare<Result = unknown>(source: string): Statement<Result>;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
