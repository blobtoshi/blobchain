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
      blob_chain: {
        Row: {
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
          winner_username: string | null
        }
        Insert: {
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
          winner_username?: string | null
        }
        Update: {
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
          winner_username?: string | null
        }
        Relationships: []
      }
      blob_entries: {
        Row: {
          address: string
          block_height: number
          block_seed: string | null
          score: number
          signature: string
          submitted_at: string | null
          username: string | null
        }
        Insert: {
          address: string
          block_height: number
          block_seed?: string | null
          score?: number
          signature: string
          submitted_at?: string | null
          username?: string | null
        }
        Update: {
          address?: string
          block_height?: number
          block_seed?: string | null
          score?: number
          signature?: string
          submitted_at?: string | null
          username?: string | null
        }
        Relationships: []
      }
      blob_mempool: {
        Row: {
          amount: number
          created_at: string | null
          fee: number | null
          from_address: string
          from_username: string | null
          id: string
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
          from_address: string
          from_username?: string | null
          id: string
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
          from_address?: string
          from_username?: string | null
          id?: string
          public_key?: string
          signature?: string
          status?: string | null
          timestamp?: number
          to_address?: string
        }
        Relationships: []
      }
      blob_players: {
        Row: {
          address: string
          best_score: number | null
          blocks_won: number | null
          first_seen: string | null
          games_played: number | null
          last_active: string | null
          public_key: string | null
          total_mined: number | null
          username: string
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
          username: string
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
          username?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_block_leaderboard: {
        Args: { p_height: number }
        Returns: {
          address: string
          rank: number
          score: number
          username: string
          win_pct: number
        }[]
      }
      get_player_stats: {
        Args: { p_address: string }
        Returns: {
          avg_score: number
          best_score: number
          blocks_won: number
          games_played: number
          total_mined: number
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
