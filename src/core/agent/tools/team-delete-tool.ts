import type { ToolDefinition } from "../actor/types";
import type { ActorSystem } from "../actor/actor-system";

export const TEAM_DELETE_TOOL_NAME = "delete_team";

export interface TeamDeleteInput {
  teamId?: string;
  name?: string;
}

export interface TeamDeleteOutput {
  success: boolean;
  message: string;
}

export function createTeamDeleteTool(actorSystem: ActorSystem): ToolDefinition {
  return {
    name: TEAM_DELETE_TOOL_NAME,
    description: "Delete an existing team",
    inputSchema: {
      type: "object",
      properties: {
        teamId: {
          type: "string",
          description: "Team ID to delete",
        },
        name: {
          type: "string",
          description: "Team name to delete",
        },
      },
    },
    handler: async (input: TeamDeleteInput, context): Promise<TeamDeleteOutput> => {
      if (input.teamId) {
        const result = actorSystem.deleteTeam(input.teamId, context.actorId);
        if (!result.deleted) {
          throw new Error(result.error || `Team "${input.teamId}" 删除失败`);
        }
        return {
          success: true,
          message: "Team deleted successfully",
        };
      }

      if (input.name) {
        const result = actorSystem.deleteTeam(input.name, context.actorId);
        if (!result.deleted) {
          throw new Error(result.error || `Team "${input.name}" not found`);
        }
        return {
          success: true,
          message: `Team "${input.name}" deleted successfully`,
        };
      }

      throw new Error("Either teamId or name must be provided");
    },
  };
}
