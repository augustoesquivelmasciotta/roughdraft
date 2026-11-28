import type { Editor } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useCallback, useEffect, useState } from "react";
import { criticMarkdownToEditorState } from "./critic-markup";
import {
  baselineTextsFromDoc,
  getChangeHighlightState,
  jumpToChange,
  setChangeBaseline,
  setChangesVisible,
} from "./editor-change-highlight";
import type { StorageBackend } from "./storage";

export interface ChangeHighlightView {
  /** How many changes the colors mark. */
  count: number;
  /** The change last jumped to (0-based), or null. */
  currentIndex: number | null;
  /** Whether the colors are showing. */
  visible: boolean;
  /** What the document is compared against, for a tooltip. */
  baselineLabel: string;
}

const EMPTY_VIEW: ChangeHighlightView = {
  count: 0,
  currentIndex: null,
  visible: true,
  baselineLabel: "",
};

/**
 * Fetches the baseline the document is compared against (`since`: absent for
 * the last review, else a file path or a git ref), hands it to the editor's
 * highlight plugin and mirrors the plugin's count and state for the toolbar.
 * `refreshKey` refetches the baseline when it changes (a delivered review
 * starts a new round).
 */
export function useChangeHighlight({
  editor,
  backend,
  path,
  since,
  refreshKey,
}: {
  editor: Editor | null;
  backend: StorageBackend | null | undefined;
  path: string | null;
  since: string | null;
  refreshKey?: string | null;
}) {
  const [view, setView] = useState<ChangeHighlightView>(EMPTY_VIEW);
  const [baselineLabel, setBaselineLabel] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only re-runs the fetch
  useEffect(() => {
    if (!editor || !backend?.getDocumentBaseline || !path) return;
    let cancelled = false;

    void backend
      .getDocumentBaseline(path, since)
      .then((baseline) => {
        if (cancelled || editor.isDestroyed) return;
        if (!baseline) {
          setChangeBaseline(editor, null);
          setBaselineLabel("");
          return;
        }
        const parsed = criticMarkdownToEditorState(baseline.content);
        const doc = ProseMirrorNode.fromJSON(editor.schema, parsed.doc);
        setChangeBaseline(editor, baselineTextsFromDoc(doc));
        setBaselineLabel(baseline.label);
      })
      .catch((error) => {
        console.error("Failed to load the baseline for changes:", error);
        if (!cancelled && !editor.isDestroyed) setChangeBaseline(editor, null);
      });

    return () => {
      cancelled = true;
    };
  }, [editor, backend, path, since, refreshKey]);

  useEffect(() => {
    if (!editor) {
      setView(EMPTY_VIEW);
      return;
    }
    const sync = () => {
      const state = getChangeHighlightState(editor);
      if (!state) return;
      setView((current) =>
        current.count === state.changes.length &&
        current.currentIndex === state.currentIndex &&
        current.visible === state.visible
          ? current
          : {
              ...current,
              count: state.changes.length,
              currentIndex: state.currentIndex,
              visible: state.visible,
            },
      );
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  const toggleVisible = useCallback(() => {
    if (!editor) return;
    const state = getChangeHighlightState(editor);
    setChangesVisible(editor, !(state?.visible ?? true));
  }, [editor]);
  const next = useCallback(() => {
    if (editor) jumpToChange(editor, 1);
  }, [editor]);
  const previous = useCallback(() => {
    if (editor) jumpToChange(editor, -1);
  }, [editor]);

  return {
    view: { ...view, baselineLabel },
    toggleVisible,
    next,
    previous,
  };
}
