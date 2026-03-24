import { PaneHeader } from "../components/shell/PaneHeader";
import { CodexWorkbench } from "../components/shell/CodexWorkbench";
import type {
  CodexContextItem,
  CodexConversationEntry,
  CodexSessionState
} from "../models/codex.js";
import type { Workspace } from "../models/workspace";

interface PendingUserInputRequest {
  requestId: string | number | null;
  itemId: string;
  turnId: string;
  questions: Array<{
    header: string;
    id: string;
    question: string;
    options?: Array<{
      label: string;
      description: string;
    }> | null;
  }>;
}

interface CodexScreenProps {
  workspace: Workspace;
  session: CodexSessionState;
  draft: string;
  contextItems: CodexContextItem[];
  conversationEntries: CodexConversationEntry[];
  highlightedContextItemId: string | null;
  pendingSendId: string | null;
  composerFocusSignal: number;
  canSend: boolean;
  pendingUserInputRequest: PendingUserInputRequest | null;
  lastSubmittedPrompt: string | null;
  onDraftChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
  onSend: () => void;
  onClearConversation: () => void;
  onClearContextItems: () => void;
  onRemoveContextItem: (itemId: string) => void;
  onSubmitUserInputRequest: (answers: Record<string, string[]>) => void;
  onNewChat: () => void;
}

export function CodexScreen({
  workspace,
  session,
  draft,
  contextItems,
  conversationEntries,
  highlightedContextItemId,
  pendingSendId,
  composerFocusSignal,
  canSend,
  pendingUserInputRequest,
  lastSubmittedPrompt,
  onDraftChange,
  onStart,
  onStop,
  onSend,
  onClearConversation,
  onClearContextItems,
  onRemoveContextItem,
  onSubmitUserInputRequest,
  onNewChat
}: CodexScreenProps) {
  return (
    <section className="workspace-screen codex-screen">
      <PaneHeader
        eyebrow="Codex"
        title="Expanded Workspace Session"
        subtitle="Use the same live Codex app-server thread as the global dock, with a larger structured conversation surface."
      />

      <CodexWorkbench
        variant="page"
        workspacePath={workspace.rootPath}
        session={session}
        draft={draft}
        contextItems={contextItems}
        conversationEntries={conversationEntries}
        highlightedContextItemId={highlightedContextItemId}
        pendingSendId={pendingSendId}
        composerFocusSignal={composerFocusSignal}
        canSend={canSend}
        pendingUserInputRequest={pendingUserInputRequest}
        lastSubmittedPrompt={lastSubmittedPrompt}
        onDraftChange={onDraftChange}
        onStart={onStart}
        onStop={onStop}
        onSend={onSend}
        onClearConversation={onClearConversation}
        onClearContextItems={onClearContextItems}
        onRemoveContextItem={onRemoveContextItem}
        onSubmitUserInputRequest={onSubmitUserInputRequest}
        onNewChat={onNewChat}
      />
    </section>
  );
}
