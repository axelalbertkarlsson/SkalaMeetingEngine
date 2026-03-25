import { PaneHeader } from "../components/shell/PaneHeader";
import { CodexWorkbench } from "../components/shell/CodexWorkbench";
import type {
  CodexContextItem,
  CodexConversationEntry,
  CodexModelOption,
  CodexReasoningEffort,
  CodexSessionState,
  CodexThreadSummary
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
  threads: CodexThreadSummary[];
  threadsLoading: boolean;
  availableModels: CodexModelOption[];
  modelsLoading: boolean;
  selectedModel: string | null;
  effectiveModelId: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  historyPanelOpen: boolean;
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
  onToggleHistoryPanel: () => void;
  onSelectThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onArchiveThread: (threadId: string) => void;
  onSelectedModelChange: (value: string | null) => void;
  onReasoningEffortChange: (value: CodexReasoningEffort | null) => void;
}

export function CodexScreen({
  workspace,
  session,
  threads,
  threadsLoading,
  availableModels,
  modelsLoading,
  selectedModel,
  effectiveModelId,
  reasoningEffort,
  historyPanelOpen,
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
  onNewChat,
  onToggleHistoryPanel,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
  onSelectedModelChange,
  onReasoningEffortChange
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
        threads={threads}
        threadsLoading={threadsLoading}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        selectedModel={selectedModel}
        effectiveModelId={effectiveModelId}
        reasoningEffort={reasoningEffort}
        historyPanelOpen={historyPanelOpen}
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
        onToggleHistoryPanel={onToggleHistoryPanel}
        onSelectThread={onSelectThread}
        onRenameThread={onRenameThread}
        onArchiveThread={onArchiveThread}
        onSelectedModelChange={onSelectedModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
      />
    </section>
  );
}
