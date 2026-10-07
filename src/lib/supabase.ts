import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Environment } from "@/config/env";
import type { Database } from "@/types/database";

export function createSupabaseAdminClient(
  environment: Environment,
): SupabaseClient<Database> {
  return createClient<Database>(
    environment.SUPABASE_URL,
    environment.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );
}
