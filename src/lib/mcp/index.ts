import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listThreadsTool from "./tools/list-threads";
import getThreadMessagesTool from "./tools/get-thread-messages";
import searchChatsTool from "./tools/search-chats";
import listContactsTool from "./tools/list-contacts";

const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "bpa-bot-mcp",
  title: "BPA Bot",
  version: "0.1.0",
  instructions:
    "Tools for the signed-in BPA Bot user. Read conversation threads and messages, search chat history, and list saved contacts.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listThreadsTool, getThreadMessagesTool, searchChatsTool, listContactsTool],
});