export type UserSummary = {
  id: string;
  displayName: string | null;
};

export type PairSummary = {
  id: string;
  createdAt: string;
  memberCount: 1 | 2;
};

export type PairMembership = {
  pairId: string;
  userId: string;
  role: "creator" | "member";
  joinedAt: string;
};

export type PetSummary = {
  id: string;
  name: string;
  createdAt: string;
};

export type InviteCodeSummary = {
  code: string;
  expiresAt: string;
};

export type WorkspaceResponse = {
  user: UserSummary;
  pair: PairSummary | null;
  pet: PetSummary | null;
  membership: PairMembership | null;
};

export type PairWorkspace = {
  pair: PairSummary;
  pet: PetSummary;
  membership: PairMembership;
};

export type CreatePairResponse = PairWorkspace & {
  invite: InviteCodeSummary;
};

export type JoinPairResponse = PairWorkspace;

export type RotateInviteResponse = {
  invite: InviteCodeSummary;
};

export type PointActivityType = "feed" | "poop" | "play";
export type StatefulActivityType = "sleep" | "alone" | "walk";
export type TreatmentActivityType = "medicine" | "ointment";
export type ActivityPhase = "started" | "ended";
export type ScheduleState = "normal" | "approaching" | "due" | "overdue";

export type CreateCareActivityInput =
  | { type: PointActivityType; note?: string }
  | { type: StatefulActivityType; phase: ActivityPhase; note?: string }
  | { type: TreatmentActivityType; treatmentScheduleId: string; note?: string }
  | { type: "custom"; label: string; note?: string };

export type CareActivity = {
  id: string;
  petId: string;
  actorUserId: string;
  actorDisplayName: string | null;
  type: PointActivityType | StatefulActivityType | TreatmentActivityType | "custom";
  phase: ActivityPhase | null;
  label: string | null;
  note: string | null;
  treatmentScheduleId: string | null;
  scheduledFor: string | null;
  occurredAt: string;
  idempotencyKey: string;
};

export type ActivePetStatuses = { sleeping: boolean; alone: boolean; walking: boolean };
export type FeedingSchedule = { timezone: string; dailyTimes: string[] };
export type FeedingHint = {
  nextFeedAt: string;
  lastFedAt: string | null;
  state: ScheduleState;
};
export type TreatmentSchedule = {
  id: string;
  petId: string;
  kind: TreatmentActivityType;
  name: string;
  timezone: string;
  dailyTimes: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
export type TreatmentScheduleHint = {
  scheduledFor: string;
  lastCompletedAt: string | null;
  state: ScheduleState;
};
export type TreatmentScheduleState = {
  schedule: TreatmentSchedule;
  hint: TreatmentScheduleHint;
};
export type CreateTreatmentScheduleInput = {
  kind: TreatmentActivityType;
  name: string;
  timezone: string;
  dailyTimes: string[];
};

export type WebPushSubscriptionKeys = {
  p256dh: string;
  auth: string;
};

export type RegisterWebPushSubscriptionInput = {
  deviceId: string;
  subscription: {
    endpoint: string;
    expirationTime: number | null;
    keys: WebPushSubscriptionKeys;
  };
};

export type CareActivityWebPushData = {
  kind: "care_activity";
  petId: string;
  activityId: string;
  url: string;
};
export type ActivityStateResponse = {
  pet: PetSummary;
  activeStatuses: ActivePetStatuses;
  feedingSchedule: FeedingSchedule | null;
  feedingHint: FeedingHint | null;
  treatmentStates: TreatmentScheduleState[];
  recentActivities: CareActivity[];
};
export type CreateActivityResponse = {
  activity: CareActivity;
  state: {
    activeStatuses: ActivePetStatuses;
    feedingHint: FeedingHint | null;
    treatmentState: TreatmentScheduleState | null;
  };
};
