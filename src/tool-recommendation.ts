import type { Skill } from "@earendil-works/pi-coding-agent";
import { noul, choice } from "pi-typesafe";
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
  // Truncate description to keep token cost low
  const truncate = (text: string, maxLen: number) =>
    text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;

  // Build options record
  const options: Record<string, string> = {};

  // Current tool option
  options["current"] = `The current tool (${currentTool}) is appropriate for this task.`;

  // Add tools (skip the current tool? We can include it but with a different key)
  for (const tool of tools) {
    const key = `tool:${tool.name}`;
    options[key] = truncate(tool.description, 120);
  }

  // Add skills
  for (const skill of skills) {
    const key = `skill:${skill.name}`;
    let desc = truncate(skill.description, 120);
    if (skill.disableModelInvocation) {
      desc += " (user-invoked only)";
    }
    options[key] = desc;
  }

  // If no options besides current, we can skip the question? But we still need the yes/no.
  // We'll keep it; Jev will pick current.

  const tool_recommendation_yes = noul(
    "Is there a more appropriate tool or skill for this task than the current tool? Consider the available tools and skills listed in the options. If the current tool is appropriate, answer no.",
    {
      true: "Yes: there is a tool or skill that would be significantly more appropriate for this task.",
      false: "No: the current tool is appropriate for this task.",
    }
  );

  const tool_recommendation_choice = choice(
    "Which tool or skill is most appropriate for this task? Consider the current tool and the available options. If the current tool is appropriate, choose 'current'.",
    options
  );

  return {
    tool_recommendation_yes,
    tool_recommendation_choice,
  };
}