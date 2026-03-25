import type {
  CodexModelOption,
  CodexModelReasoningEffortOption,
  CodexReasoningEffort
} from "../models/codex.js";

export function formatCodexModelLabel(label: string) {
  return label.trim().replace(/\bgpt(?=-)/gi, "GPT");
}

function normalizedModelId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function createUnknownCodexModelOption(modelId: string): CodexModelOption {
  return {
    id: modelId,
    displayName: formatCodexModelLabel(modelId),
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    inputModalities: [],
    supportsPersonality: false,
    isDefault: false,
    hidden: false
  };
}

export function formatReasoningEffortLabel(effort: CodexReasoningEffort) {
  if (effort === "xhigh") {
    return "Extra high";
  }

  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function findCodexModelOption(
  availableModels: CodexModelOption[],
  modelId: string | null | undefined
) {
  const normalizedId = normalizedModelId(modelId);
  if (!normalizedId) {
    return null;
  }

  return availableModels.find((model) => model.id === normalizedId) ?? null;
}

export function getResolvedCodexModelOption(
  availableModels: CodexModelOption[],
  selectedModel: string | null,
  effectiveModelId: string | null
) {
  return (
    findCodexModelOption(availableModels, selectedModel)
    ?? findCodexModelOption(availableModels, effectiveModelId)
  );
}

export function getCodexModelDisplayName(
  availableModels: CodexModelOption[],
  modelId: string | null
) {
  const normalizedId = normalizedModelId(modelId);
  if (!normalizedId) {
    return null;
  }

  return (
    findCodexModelOption(availableModels, normalizedId)?.displayName
    ?? formatCodexModelLabel(normalizedId)
  );
}

export function getCodexModelSelectOptions(
  availableModels: CodexModelOption[],
  selectedModel: string | null
) {
  const visibleModels = availableModels.filter((model) => !model.hidden);
  const normalizedSelectedModel = normalizedModelId(selectedModel);
  if (!normalizedSelectedModel) {
    return visibleModels;
  }

  if (visibleModels.some((model) => model.id === normalizedSelectedModel)) {
    return visibleModels;
  }

  return [
    ...visibleModels,
    findCodexModelOption(availableModels, normalizedSelectedModel)
    ?? createUnknownCodexModelOption(normalizedSelectedModel)
  ];
}

export function getCodexReasoningSelectOptions(
  resolvedModelOption: CodexModelOption | null,
  currentReasoningEffort: CodexReasoningEffort | null
) {
  const options = resolvedModelOption?.supportedReasoningEfforts ?? [];
  if (
    currentReasoningEffort
    && !options.some((option) => option.reasoningEffort === currentReasoningEffort)
  ) {
    return [
      ...options,
      {
        reasoningEffort: currentReasoningEffort,
        description: null
      } satisfies CodexModelReasoningEffortOption
    ];
  }

  return options;
}
