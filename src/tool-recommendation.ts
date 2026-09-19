import type { Skill } from "@earendil-works/pi-coding-agent";
import { choice, noul } from "pi-typesafe";
import type { Questions } from "pi-typesafe";

interface ToolInfo {
  name: string;
  description: string;
}

/**
 * Build the tool-recommendation questions for Jev.
 * @param tools - list of available tools (name + description)
 * @param skills - list of available skills (from system prompt options)
 * @param currentTool - the tool the agent is currently using
 * @returns Questions object to be merged into the action guard request
 */
export function buildToolRecommendationQuestions(
  tools: ToolInfo[],
  skills: Skill[],
  currentTool: string,
): Questions {
  const truncate = (text: string, maxLen: number) =>
    text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;

  const options: Record<string, string> = {};
  options["current"] = `The current tool (${currentTool}) is appropriate for this task.`;

  for (const tool of tools) {
    options[`tool:${tool.name}`] = truncate(tool.description, 120);
  }

  for (const skill of skills) {
    let desc = truncate(skill.description, 120);
    if (skill.disableModelInvocation) {
      desc += " (user-invoked only)";
    }
    options[`skill:${skill.name}`] = desc;
  }

  // Both questions are extra (recorded, never acted on) until measured.
  return {
    tool_recommendation_yes: noul(
      "Is there a more appropriate tool or skill for this task than the current tool? Consider the available tools and skills listed in the options. If the current tool is appropriate, answer no.",
      {
        true: "Yes: there is a tool or skill that would be significantly more appropriate for this task.",
        false: "No: the current tool is appropriate for this task.",
      },
    ),
    tool_recommendation_choice: choice(
      "Which tool or skill is most appropriate for this task? Consider the current tool and the available options. If the current tool is appropriate, choose 'current'.",
      options,
    ),
  };
}
