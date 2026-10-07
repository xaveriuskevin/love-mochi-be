export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type RpcFunction<Args extends Record<string, unknown>> = {
  Args: Args;
  Returns: Json;
};

export type Database = {
  public: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: {
      get_my_workspace: RpcFunction<{ requested_user_id: string }>;
      create_pair: RpcFunction<{
        requested_user_id: string;
        requested_pet_name: string;
        requested_invite_hash: string;
      }>;
      join_pair_by_invite: RpcFunction<{
        requested_user_id: string;
        requested_invite_hash: string;
      }>;
      rotate_pair_invite: RpcFunction<{
        requested_user_id: string;
        requested_invite_hash: string;
      }>;
      get_activity_state: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
      }>;
      list_care_activities: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
        requested_limit: number;
        cursor_occurred_at: string | null;
        cursor_id: string | null;
      }>;
      create_care_activity: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
        requested_type: string;
        requested_phase: string | null;
        requested_label: string | null;
        requested_note: string | null;
        requested_treatment_schedule_id: string | null;
        requested_idempotency_key: string;
        requested_request_hash: string;
      }>;
      put_feeding_schedule: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
        requested_timezone: string;
        requested_daily_times: string[];
      }>;
      list_treatment_schedules: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
      }>;
      create_treatment_schedule: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
        requested_kind: string;
        requested_name: string;
        requested_timezone: string;
        requested_daily_times: string[];
      }>;
      update_treatment_schedule: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
        requested_schedule_id: string;
        requested_name: string | null;
        requested_timezone: string | null;
        requested_daily_times: string[] | null;
        update_name: boolean;
        update_timezone: boolean;
        update_daily_times: boolean;
      }>;
      archive_treatment_schedule: RpcFunction<{
        requested_user_id: string;
        requested_pet_id: string;
        requested_schedule_id: string;
      }>;
      register_web_push_subscription: RpcFunction<{
        requested_user_id: string;
        requested_device_id: string;
        requested_endpoint: string;
        requested_expiration_time: number | null;
        requested_p256dh: string;
        requested_auth: string;
      }>;
      remove_web_push_subscription: RpcFunction<{
        requested_user_id: string;
        requested_device_id: string;
      }>;
      claim_care_notification: RpcFunction<{
        requested_user_id: string;
        requested_activity_id: string;
      }>;
      disable_web_push_subscription: RpcFunction<{
        requested_subscription_id: string;
        requested_reason: string;
      }>;
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
