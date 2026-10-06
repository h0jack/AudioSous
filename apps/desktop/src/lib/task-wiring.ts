import { cancelAutoBalance, runAutoBalance } from "./autobalance";
import { cancelDynamicsPlan, runDynamicsPlan } from "./dynamics";
import { cancelEqPlan, runEqPlan } from "./eq";
import { cancelFullMixPlan, runFullMixPlan } from "./full-mix";
import { cancelSpacePlan, runSpacePlan } from "./space";
import { cancelAssistant } from "./assistant";
import { registerTaskActions } from "./tasks";

/** Cancel and retry for the work the store publishes on its own (the planners and the assistant). */
export function wireTaskActions(): void {
  registerTaskActions("gain-plan", { cancel: cancelAutoBalance, retry: () => void runAutoBalance() });
  registerTaskActions("eq-plan", { cancel: cancelEqPlan, retry: () => void runEqPlan() });
  registerTaskActions("space-plan", { cancel: cancelSpacePlan, retry: () => void runSpacePlan() });
  registerTaskActions("dynamics-plan", { cancel: cancelDynamicsPlan, retry: () => void runDynamicsPlan() });
  registerTaskActions("full-mix", { cancel: cancelFullMixPlan, retry: () => void runFullMixPlan() });
  registerTaskActions("assistant", { cancel: () => cancelAssistant() });
}
