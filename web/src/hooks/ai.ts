import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AiStatus } from "../api/types";

/** Whether AI Mode is on and whether the assistant can run. */
export function useAiStatus() {
  return useQuery({ queryKey: ["ai", "status"], queryFn: () => api<AiStatus>("/ai/status"), staleTime: 60_000 });
}
