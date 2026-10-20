import type { Tokens } from "./runtime";
import { machinePlan } from "./runtime";
export type AccountMachine = {
  id: string;
  name: string;
  state: string;
  region: string;
  config: {
    metadata?: Record<string, string>;
    mounts?: {
      volume: string;
      path: string;
    }[];
    image?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type AccountVolume = {
  id: string;
  name: string;
  region: string;
  attached_machine_id?: string | null;
  [key: string]: unknown;
};
export type PlanInput = {
  accountId: string;
  volumeId: string;
  image: string;
  controlUrl: string;
  tokens: Tokens;
};
export interface Machines {
  listMachines(): Promise<AccountMachine[]>;
  listVolumes(): Promise<AccountVolume[]>;
  createVolume(name: string): Promise<AccountVolume>;
  createMachine(plan: unknown): Promise<AccountMachine>;
  start(id: string): Promise<void>;
  update(id: string, config: unknown): Promise<void>;
}
export interface AccountDriver extends Machines {
  readonly kind: "fly" | "docker";
  readonly region: string;
  plan(input: PlanInput): ReturnType<typeof machinePlan>;
  validateImage(image: string): void;
  validateDeployment(input: Omit<PlanInput, "volumeId">): void;
  endpoint(id: string, app: string): Promise<string>;
}
export function driverFor(machines: Machines): AccountDriver {
  if ("kind" in machines) return machines as AccountDriver;
  return Object.assign(Object.create(machines), {
    kind: "fly" as const,
    region: "nrt",
    plan: machinePlan,
    validateDeployment(input: Omit<PlanInput, "volumeId">) {
      machinePlan({ ...input, volumeId: "vol_validation" });
    },
    validateImage(image: string) {
      machinePlan({
        accountId: "12345678-1234-4234-8234-123456789abc",
        volumeId: "vol_validation",
        image,
        controlUrl: "http://control.internal/",
        tokens: { auth: "a".repeat(43), container: "b".repeat(43) },
      });
    },
    async endpoint(id: string, app: string) {
      if (
        !/^[a-f0-9]{10,32}$/.test(id) ||
        !/^[a-z0-9][a-z0-9-]{1,62}$/.test(app)
      )
        throw Error("MACHINE_ID_INVALID");
      return `http://${id}.vm.${app}.internal:4096`;
    },
  });
}
