import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { AIConfig, AIRequestMessage } from "@/core/ai/types";
import { handleError } from "@/core/errors";
import { getRoutedConfig } from "@/core/ai/router";

export function useAiCompletion(onAccept?: (text: string) => void) {
  const [completion, setCompletion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const completionRef = useRef("");

  const generateCompletion = useCallback(async (context: string) => {
    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    if (context.trim().length < 5) return;

    setIsLoading(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // 1. Get current AI config
      const config = await invoke<AIConfig>("ai_get_config");

      // 2. Construct prompt for completion
      const prompt = `Continue the following text naturally. Requirements:
- Return ONLY the continuation text (1 short sentence or phrase)
- Use the same language as the context
- Do NOT use code blocks or markdown formatting
- Return plain text only

Context:
${context.slice(-500)}

Continuation:`;

      // 3. Call AI Chat (non-stream for simplicity in v1)
      // We use a modified config for speed (low tokens)
      const completionConfig = { ...config, max_tokens: 50, temperature: 0.3 };

      const messages: AIRequestMessage[] = [{ role: "user", content: prompt }];

      const result = await invoke<string>("ai_chat", {
        messages,
        config: getRoutedConfig(completionConfig),
      });

      if (!controller.signal.aborted && result) {
        // Clean up result
        const cleanText = result
          .trim()
          .replace(/^["']|["']$/g, "")
          .replace(/^Continuation:\s*/i, "");

        if (cleanText) {
          completionRef.current = cleanText;
          setCompletion(cleanText);
        }
      }
    } catch (error) {
      handleError(error, { context: "AI 续写" });
    } finally {
      if (abortControllerRef.current === controller) {
        setIsLoading(false);
        abortControllerRef.current = null;
      }
    }
  }, []);

  const acceptCompletion = useCallback(() => {
    if (completionRef.current && onAccept) {
      onAccept(completionRef.current);
      setCompletion("");
      completionRef.current = "";
    }
  }, [onAccept]);

  const cancelCompletion = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setCompletion("");
    completionRef.current = "";
    setIsLoading(false);
  }, []);

  return {
    completion,
    isLoading,
    generateCompletion,
    acceptCompletion,
    cancelCompletion,
  };
}
