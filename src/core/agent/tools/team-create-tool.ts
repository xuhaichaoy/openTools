import type { ToolDefinition } from "../actor/types";
import type { ActorSystem } from "../actor/actor-system";

export const TEAM_CREATE_TOOL_NAME = "create_team";

export interface TeamCreateInput {
  name: string;
  description?: string;
}

export interface TeamCreateOutput {
  success: boolean;
  teamId: string;
  message: string;
}

export function createTeamCreateTool(actorSystem: ActorSystem): ToolDefinition {
  return {
    name: TEAM_CREATE_TOOL_NAME,
    description: "Create a new team for multi-agent collaboration",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Team name",
        },
        description: {
          type: "string",
          description: "Optional team description",
        },
      },
      required: ["name"],
    },
    handler: async (input: TeamCreateInput, context): Promise<TeamCreateOutput> => {
      const result = actorSystem.createTeam({
        name: input.name,
        description: input.description,
        createdByActorId: context.actorId || "leader",
      });

      return {
        success: true,
        teamId: result.team.id,
        message: `Team "${input.name}" created successfully`,
      };
    },
  };
}
