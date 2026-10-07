export interface HealthStatus {
  status: "ok";
}

export function getHealthStatus(): HealthStatus {
  return { status: "ok" };
}
