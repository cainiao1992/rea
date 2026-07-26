export interface PackageRunnerSetupInput {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly packageRoot: string;
  readonly packageName: string;
}

export interface PackageRunnerSetupPlan {
  readonly command: "npm";
  readonly args: readonly string[];
}

export function packageRunnerSetupPlan(
  input: PackageRunnerSetupInput,
): PackageRunnerSetupPlan | undefined;

export function runPackageRunnerSetupBootstrap(
  input: PackageRunnerSetupInput,
): Promise<number | undefined>;
