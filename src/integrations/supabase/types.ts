export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      access_codes: {
        Row: {
          code: string
          created_at: string
          note: string | null
          used_at: string | null
          used_by_fingerprint: string | null
        }
        Insert: {
          code: string
          created_at?: string
          note?: string | null
          used_at?: string | null
          used_by_fingerprint?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          note?: string | null
          used_at?: string | null
          used_by_fingerprint?: string | null
        }
        Relationships: []
      }
      access_requests: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          status: string
          x_username: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          status?: string
          x_username: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          status?: string
          x_username?: string
        }
        Relationships: []
      }
      blob_addresses: {
        Row: {
          address: string
          best_score: number | null
          blocks_won: number | null
          first_seen: string | null
          games_played: number | null
          last_active: string | null
          public_key: string | null
          total_mined: number | null
        }
        Insert: {
          address: string
          best_score?: number | null
          blocks_won?: number | null
          first_seen?: string | null
          games_played?: number | null
          last_active?: string | null
          public_key?: string | null
          total_mined?: number | null
        }
        Update: {
          address?: string
          best_score?: number | null
          blocks_won?: number | null
          first_seen?: string | null
          games_played?: number | null
          last_active?: string | null
          public_key?: string | null
          total_mined?: number | null
        }
        Relationships: []
      }
      blob_chain: {
        Row: {
          block_hash_v2: string | null
          created_at: string | null
          hash: string
          height: number
          mining_entries: string | null
          node_count: number | null
          previous_hash: string
          reward: number | null
          seed: string
          timestamp: number
          total_supply: number | null
          transactions: string | null
          winner: string | null
          winner_score: number | null
        }
        Insert: {
          block_hash_v2?: string | null
          created_at?: string | null
          hash: string
          height: number
          mining_entries?: string | null
          node_count?: number | null
          previous_hash: string
          reward?: number | null
          seed: string
          timestamp: number
          total_supply?: number | null
          transactions?: string | null
          winner?: string | null
          winner_score?: number | null
        }
        Update: {
          block_hash_v2?: string | null
          created_at?: string | null
          hash?: string
          height?: number
          mining_entries?: string | null
          node_count?: number | null
          previous_hash?: string
          reward?: number | null
          seed?: string
          timestamp?: number
          total_supply?: number | null
          transactions?: string | null
          winner?: string | null
          winner_score?: number | null
        }
        Relationships: []
      }
      blob_entries: {
        Row: {
          address: string
          block_height: number
          block_seed: string | null
          frame_count: number | null
          inputs: string | null
          inputs_hash: string | null
          score: number
          signature: string
          submitted_at: string | null
        }
        Insert: {
          address: string
          block_height: number
          block_seed?: string | null
          frame_count?: number | null
          inputs?: string | null
          inputs_hash?: string | null
          score?: number
          signature: string
          submitted_at?: string | null
        }
        Update: {
          address?: string
          block_height?: number
          block_seed?: string | null
          frame_count?: number | null
          inputs?: string | null
          inputs_hash?: string | null
          score?: number
          signature?: string
          submitted_at?: string | null
        }
        Relationships: []
      }
      blob_mempool: {
        Row: {
          amount: number
          created_at: string | null
          fee: number | null
          fee_rate: number | null
          from_address: string
          id: string
          memo: string | null
          public_key: string
          signature: string
          status: string | null
          timestamp: number
          to_address: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          fee?: number | null
          fee_rate?: number | null
          from_address: string
          id: string
          memo?: string | null
          public_key: string
          signature: string
          status?: string | null
          timestamp: number
          to_address: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          fee?: number | null
          fee_rate?: number | null
          from_address?: string
          id?: string
          memo?: string | null
          public_key?: string
          signature?: string
          status?: string | null
          timestamp?: number
          to_address?: string
        }
        Relationships: []
      }
      bridge_redeems: {
        Row: {
          amount: number
          blob_address: string
          blob_tx_id: string | null
          bridge_fee: number | null
          created_at: string
          credit_amount: number | null
          credited_at: string | null
          error: string | null
          sol_signature: string
          status: string
          verified_at: string | null
        }
        Insert: {
          amount: number
          blob_address: string
          blob_tx_id?: string | null
          bridge_fee?: number | null
          created_at?: string
          credit_amount?: number | null
          credited_at?: string | null
          error?: string | null
          sol_signature: string
          status?: string
          verified_at?: string | null
        }
        Update: {
          amount?: number
          blob_address?: string
          blob_tx_id?: string | null
          bridge_fee?: number | null
          created_at?: string
          credit_amount?: number | null
          credited_at?: string | null
          error?: string | null
          sol_signature?: string
          status?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      bridge_requests: {
        Row: {
          amount: number
          blob_tx_id: string
          confirmed_at: string | null
          created_at: string
          error: string | null
          from_address: string
          minted_at: string | null
          sol_address: string
          sol_signature: string | null
          status: string
        }
        Insert: {
          amount: number
          blob_tx_id: string
          confirmed_at?: string | null
          created_at?: string
          error?: string | null
          from_address: string
          minted_at?: string | null
          sol_address: string
          sol_signature?: string | null
          status?: string
        }
        Update: {
          amount?: number
          blob_tx_id?: string
          confirmed_at?: string | null
          created_at?: string
          error?: string | null
          from_address?: string
          minted_at?: string | null
          sol_address?: string
          sol_signature?: string | null
          status?: string
        }
        Relationships: []
      }
    }
    Views: {
      blob_addresses_public: {
        Row: {
          address: string | null
          best_score: number | null
          blocks_won: number | null
          first_seen: string | null
          games_played: number | null
          last_active: string | null
          total_mined: number | null
        }
        Insert: {
          address?: string | null
          best_score?: number | null
          blocks_won?: number | null
          first_seen?: string | null
          games_played?: number | null
          last_active?: string | null
          total_mined?: number | null
        }
        Update: {
          address?: string | null
          best_score?: number | null
          blocks_won?: number | null
          first_seen?: string | null
          games_played?: number | null
          last_active?: string | null
          total_mined?: number | null
        }
        Relationships: []
      }
      bridge_audit: {
        Row: {
          total_bridge_txs: number | null
          total_locked_blob: number | null
          total_minted_blob: number | null
          unreconciled_blob: number | null
          unreconciled_count: number | null
        }
        Relationships: []
      }
      bridge_ledger: {
        Row: {
          amount: number | null
          blob_tx_id: string | null
          block_height: number | null
          block_timestamp: number | null
          from_address: string | null
          memo: string | null
          memo_sol_address: string | null
          mint_error: string | null
          mint_signature: string | null
          mint_sol_address: string | null
          mint_status: string | null
          minted_at: string | null
          to_address: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      compute_block_hash_v2: {
        Args: {
          p_height: number
          p_previous_hash: string
          p_reward: number
          p_seed: string
          p_timestamp: number
          p_transactions: string
          p_winner: string
          p_winner_score: number
        }
        Returns: string
      }
      get_address_stats: {
        Args: { p_address: string }
        Returns: {
          avg_score: number
          best_score: number
          blocks_won: number
          games_played: number
          total_mined: number
        }[]
      }
      get_block_leaderboard: {
        Args: { p_height: number }
        Returns: {
          address: string
          rank: number
          score: number
          win_pct: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
