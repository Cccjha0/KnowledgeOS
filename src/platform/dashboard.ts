import { collectApplicationDashboardItems } from "../application/dashboard.js";
import { buildTodayDashboard } from "../core/dashboard.js";

export async function rebuildTodayDashboard(vaultRoot: string): Promise<string> {
  const applicationItems = await collectApplicationDashboardItems(vaultRoot);
  return buildTodayDashboard(vaultRoot, applicationItems);
}
