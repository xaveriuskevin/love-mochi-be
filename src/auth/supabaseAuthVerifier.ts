import type { SupabaseClient } from "@supabase/supabase-js";

import type { AuthVerifier } from "@/middleware/auth";
import type { Database } from "@/types/database";

export function createSupabaseAuthVerifier(
  client: SupabaseClient<Database>,
): AuthVerifier {
  return {
    async verifyAccessToken(accessToken) {
      const { data, error } = await client.auth.getUser(accessToken);

      if (error !== null) return null;

      return { id: data.user.id };
    },
  };
}
