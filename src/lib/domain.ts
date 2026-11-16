// Enumerations shared by validation, the agent and the UI. Must match the CHECK
// constraints in supabase/migrations.
export const CATEGORIES = [
  "elevator",
  "leak",
  "common_electricity",
  "tenant_club",
  "door_or_code",
  "cleaning",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const UNIT_ROLES = ["owner", "tenant", "committee"] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];

export const APPROVAL_POLICIES = ["first", "majority", "all"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];
