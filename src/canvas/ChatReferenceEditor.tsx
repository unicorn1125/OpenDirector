import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import type { ChatAsset } from "../backend/chat.ts";
import { CanvasIcon } from "./CanvasIcon";
import {
  assetKind,
  blankContent,
  contentText,
  normalizeContent,
  currentReferences,
  referencePart,
  referenceIds,
  referenceIsOffCanvas,
  fingerprintMatches,
  validContent,
  type ReferenceAsset,
  type ReferenceContent,
} from "./chatReferenceContent.ts";
import {
  editContent,
  editingText,
  readDOM,
  select,
  selection,
  type Caret,
} from "./chatReferenceDOM.ts";
import { referenceInsertion } from "./chatReferenceInsertion.ts";
import type { ReferenceRules } from "./chatReferenceInsertion.ts";
import {
  mentionCategories,
  mentionRange,
  slashRange,
  REFERENCE_CATEGORIES,
  type MentionOption,
  type ReferenceCategory,
} from "./referenceMentions.ts";
import "./reference-mentions.css";
import { assetDisplayName } from "./assetNames.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";

export interface ChatReferenceEditorHandle {
  focus: () => void;
  openPicker: () => void;
  setSkill: (name: string | null, fromSlash?: boolean) => void;
  caret: () => Caret;
  removeSource: (nodeId: string) => boolean;
  insert: (
    assets: ChatAsset[],
    range?: Caret,
    deduplicate?: boolean,
  ) => boolean;
}
interface Props {
  scope: string;
  value: ReferenceContent;
  assets: ReferenceAsset[];
  previews: Record<string, string>;
  options: MentionOption[];
  disabled: boolean;
  referencesDisabled: boolean;
  loading: boolean;
  loadError: string;
  onOpen: () => void;
  onChoose: (
    option: MentionOption,
    signal: AbortSignal,
  ) => Promise<ReferenceAsset[] | null>;
  onChange: (content: ReferenceContent, added?: ReferenceAsset[]) => void;
  onSubmit: () => void;
  onPasteFiles: (files: File[]) => void;
  onConfirmPending?: (caret: Caret) => void;
  onSlashChange?: (query: string | null) => void;
  skillsEnabled?: boolean;
  label?: string;
  placeholder?: string;
  className?: string;
  autoGrow?: boolean;
  referenceRules?: ReferenceRules;
  submitOnEnter?: boolean;
  metadataOnlyKinds?: readonly string[];
  visibleReferenceNodeIds?: ReadonlySet<string>;
  onPasteReference?: (
    part: Extract<ReferenceContent[number], { type: "reference" }>,
    signal: AbortSignal,
  ) => Promise<ReferenceAsset[]>;
  rebindOnPaste?: boolean;
  ref: Ref<ChatReferenceEditorHandle>;
}
type Snapshot = { content: ReferenceContent; caret: Caret };
const CLIPBOARD = "application/x-opendirector-references";
const defaultRules = {
  allowedKinds: ["image", "video", "audio", "text"],
  maxImages: 64,
  imageBytes: 32 * 1024 * 1024,
};
const CATEGORY_LABELS: Record<ReferenceCategory, MessageKey> = {
  all: "assistant.reference.category.all",
  image: "assistant.kind.image",
  video: "assistant.kind.video",
  audio: "assistant.kind.audio",
  text: "assistant.kind.text",
  subject: "assistant.kind.subject",
};

/** OpenDirector's atomic content model: one reference is one editing position. */
export function ChatReferenceEditor({
  scope,
  value,
  assets,
  previews,
  options,
  disabled,
  referencesDisabled,
  loading,
  loadError,
  onOpen,
  onChoose,
  onChange,
  onSubmit,
  onPasteFiles,
  onConfirmPending,
  onSlashChange,
  skillsEnabled = false,
  label: labelProp,
  placeholder: placeholderProp,
  className = "",
  autoGrow = false,
  referenceRules = defaultRules,
  submitOnEnter = true,
  metadataOnlyKinds = [],
  visibleReferenceNodeIds,
  onPasteReference,
  rebindOnPaste = false,
  ref,
}: Props) {
  const t = useT();
  const label = labelProp ?? t("assistant.reference.editorLabel");
  const placeholder = placeholderProp ?? t("assistant.reference.placeholder");
  const rules = referenceRules;
  const root = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const iconTemplates = useRef<HTMLSpanElement>(null);
  const current = useRef(value),
    saved = useRef<Caret>({ start: 0, end: 0 });
  const slash = useRef<ReturnType<typeof slashRange>>(null);
  const past = useRef<Snapshot[]>([]),
    future = useRef<Snapshot[]>([]),
    lastEdit = useRef(0);
  const composing = useRef(false),
    choosing = useRef(false),
    alive = useRef(true);
  const preparation = useRef<AbortController | null>(null),
    dismissed = useRef<number | null>(null),
    explicitPicker = useRef(false);
  const [range, setRange] = useState<Caret | null>(null),
    rangeRef = useRef(range);
  rangeRef.current = range;
  const [category, setCategory] = useState<ReferenceCategory>("all"),
    [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const latest = useRef({onChange, onChoose, onOpen, assets, previews, visibleReferenceNodeIds, onSlashChange});
  latest.current = {onChange, onChoose, onOpen, assets, previews, visibleReferenceNodeIds, onSlashChange};
  const listId = useId();
  const categories = mentionCategories(options);
  const effectiveCategory = categories.includes(category) ? category : "all";
  const shown = options.filter(
    (option) =>
      effectiveCategory === "all" || option.kind === effectiveCategory,
  );
  const selected = Math.min(active, Math.max(0, shown.length - 1));
  const caret = () =>
    (root.current && selection(root.current)) || saved.current;
  function close() {
    preparation.current?.abort();
    explicitPicker.current = false;
    dismissed.current = rangeRef.current?.start ?? null;
    rangeRef.current = null;
    setRange(null);
  }
  function decorate() {
    root.current
      ?.querySelectorAll<HTMLElement>("[data-reference]")
      .forEach((chip) => {
        const part = JSON.parse(chip.dataset.reference!);
        const asset =
          latest.current.assets.find(
            (asset) =>
              asset.id === part.assetId &&
              asset.referenceId === part.referenceId,
          ) ?? latest.current.assets.find((asset) => asset.id === part.assetId);
        const displayName = assetDisplayName(asset?.nodeTitle || part.name);
        const label = chip.querySelector<HTMLElement>(
          ".cw-chat-reference-label",
        );
        if (label) label.textContent = displayName;
        chip.setAttribute("aria-label", t("assistant.reference.chip", { name: displayName }));
        const src = latest.current.previews[part.assetId];
        const metadataOnly =
          asset && metadataOnlyKinds.includes(assetKind(asset));
        const offCanvas =
          !!latest.current.visibleReferenceNodeIds &&
          referenceIsOffCanvas(
            part,
            asset,
            latest.current.visibleReferenceNodeIds,
          );
        chip.classList.toggle("is-off-canvas", offCanvas);
        chip.title =
          displayName +
          (part.binding === "asset" ? t("assistant.reference.pinned") : "") +
          (offCanvas ? t("assistant.reference.offCanvas") : "") +
          (metadataOnly ? t("assistant.reference.metadataOnly") : "");
        chip.querySelector("[data-reference-info]")?.remove();
        if (metadataOnly) {
          const hint = document.createElement("small");
          hint.dataset.referenceInfo = "1";
          hint.textContent = t("assistant.reference.metadataHint");
          chip.append(hint);
        }
        chip.classList.toggle(
          "is-unavailable",
          !asset ||
            (part.binding === "asset"
              ? asset.fileAvailable === false
              : asset.available === false) ||
            !!(
              part.fingerprint && !fingerprintMatches(asset, part.fingerprint)
            ),
        );
        chip.querySelector("img")?.remove();
        if (src) {
          const img = document.createElement("img");
          img.src = src;
          img.alt = "";
          img.draggable = false;
          chip.prepend(img);
        }
        const icon = chip.querySelector<HTMLElement>("[data-reference-icon]")!;
        icon.hidden = !!src;
        const template = iconTemplates.current?.querySelector(
          `[data-kind="${asset ? assetKind(asset) : "text"}"]`,
        );
        if (template) icon.replaceChildren(template.cloneNode(true));
      });
  }
  function paint(content: ReferenceContent, at?: Caret) {
    if (!root.current) return;
    const blank = blankContent(content);
    const fragment = document.createDocumentFragment();
    // Blank content is drawn as nothing, so a draft holding only line breaks
    // cannot leave an extra empty line above the prompt.
    for (const part of blank ? [] : content) {
      if (part.type === "text")
        fragment.append(document.createTextNode(part.text));
      else if (part.type === "skill") {
        const chip = document.createElement("span");
        chip.contentEditable = "false";
        chip.dataset.skill = part.name;
        chip.className = "cw-chat-skill-token";
        chip.textContent = `/${part.name}`;
        chip.setAttribute("aria-label", t("assistant.reference.skillChip", { name: part.name }));
        fragment.append(chip);
      } else {
        const chip = document.createElement("span");
        chip.contentEditable = "false";
        chip.dataset.reference = JSON.stringify(part);
        chip.className = "cw-chat-reference";
        chip.setAttribute("aria-label", t("assistant.reference.chip", { name: assetDisplayName(part.name) }));
        const icon = document.createElement("span");
        icon.dataset.referenceIcon = "1";
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "cw-chat-reference-label";
        label.textContent = assetDisplayName(part.name);
        chip.append(icon, label);
        fragment.append(chip);
      }
    }
    fragment.append(document.createTextNode("\u200b"));
    root.current.replaceChildren(fragment);
    root.current.dataset.empty = String(blank);
    decorate();
    if (at) {
      select(root.current, at);
      saved.current = at;
    }
  }
  function focus(at = saved.current) {
    if (!root.current) return;
    root.current.focus({ preventScroll: true });
    select(root.current, at);
  }
  function publish(
    content: ReferenceContent,
    at: Caret,
    redraw = true,
    typing = false,
    added: ReferenceAsset[] = [],
  ) {
    const normalized = normalizeContent(content);
    // Line breaks and spaces left behind by deletion are editing residue: the
    // editor is still empty, so it keeps its prompt and publishes no message.
    const next = blankContent(normalized) ? [] : normalized;
    if (!validContent(next)) {
      setNotice(next.filter(part => part.type === "skill").length > 1 ? t("assistant.reference.tooManySkills") : t("assistant.reference.limit"));
      paint(current.current, saved.current);
      return false;
    }
    if (JSON.stringify(next) !== JSON.stringify(current.current)) {
      try {
        latest.current.onChange(next, added);
      } catch (error) {
        setNotice((error as Error).message);
        paint(current.current, saved.current);
        return false;
      }
      if (!typing || Date.now() - lastEdit.current > 600) {
        past.current.push({ content: current.current, caret: saved.current });
        if (past.current.length > 100) past.current.shift();
      }
      future.current = [];
      lastEdit.current = typing ? Date.now() : 0;
      current.current = next;
    }
    const blank = next.length === 0;
    const nextAt = blank ? { start: 0, end: 0 } : at;
    saved.current = nextAt;
    // An emptied editor is repainted even while typing: it restores the
    // zero-width anchor in place of the browser's leftover line break, so the
    // prompt returns and the caret stays on the only line.
    if (redraw || blank) paint(next, nextAt);
    else if (root.current) root.current.dataset.empty = "false";
    setNotice("");
    return true;
  }
  function insert(
    added: ReferenceAsset[],
    at = rangeRef.current ?? caret(),
    deduplicate = false,
  ) {
    try {
      const next = referenceInsertion(
        current.current,
        at,
        added,
        latest.current.assets,
        rules,
        deduplicate,
        t,
      );
      if (!publish(next.content, next.caret, true, false, added)) return false;
      rangeRef.current = null;
      setRange(null);
      dismissed.current = null;
      // Preparing assets may disable editing until the next React commit.
      requestAnimationFrame(() => {
        if (alive.current) focus(next.caret);
      });
      return true;
    } catch (error) {
      setNotice((error as Error).message);
      return false;
    }
  }
  function open(at: Caret) {
    if (disabled || referencesDisabled || choosing.current) return;
    if (!rangeRef.current) {
      setCategory("all");
      setActive(0);
      setNotice("");
      latest.current.onOpen();
    }
    rangeRef.current = at;
    setRange(at);
  }
  function updateMention() {
    if (composing.current || choosing.current || disabled) return;
    const at = caret();
    saved.current = at;
    slash.current = slashRange(editingText(current.current), at.start, at.end);
    latest.current.onSlashChange?.(slash.current?.query ?? null);
    if (referencesDisabled) return;
    const next = mentionRange(editingText(current.current), at.start, at.end);
    if (!next) {
      // The connected-reference button opens the picker with no "@" in the
      // text. A focus selectionchange must not immediately close that picker.
      if (explicitPicker.current) return;
      dismissed.current = null;
      rangeRef.current = null;
      setRange(null);
    } else if (dismissed.current !== next.start) open(next);
  }
  useEffect(() => {
    function selectionChanged() {
      if (!root.current || document.activeElement !== root.current) return;
      const at = selection(root.current);
      if (
        at &&
        (at.start !== saved.current.start || at.end !== saved.current.end)
      )
        updateMention();
    }
    // selectionchange runs after the browser moves its native caret. A
    // microtask from keydown still sees the previous position in Chromium.
    document.addEventListener("selectionchange", selectionChanged);
    return () =>
      document.removeEventListener("selectionchange", selectionChanged);
  }, [disabled, referencesDisabled]);
  async function choose(option: MentionOption) {
    if (
      disabled ||
      referencesDisabled ||
      choosing.current ||
      option.disabledReason ||
      loading ||
      loadError
    )
      return;
    const before = current.current,
      at = rangeRef.current ?? caret();
    const abort = new AbortController();
    preparation.current = abort;
    choosing.current = true;
    setBusy(true);
    setNotice("");
    try {
      const added = await latest.current.onChoose(option, abort.signal);
      if (
        !added ||
        !alive.current ||
        abort.signal.aborted ||
        current.current !== before
      )
        return;
      insert(added, at);
    } catch (error) {
      if (!abort.signal.aborted && alive.current)
        setNotice((error as Error).message);
    } finally {
      choosing.current = false;
      if (preparation.current === abort) preparation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  async function pasteReferences(content: ReferenceContent, at: Caret) {
    if (!onPasteReference || choosing.current || disabled || referencesDisabled)
      return;
    const before = current.current;
    const abort = new AbortController();
    preparation.current = abort;
    choosing.current = true;
    setBusy(true);
    setNotice("");
    try {
      const inserted: ReferenceContent = [],
        added: ReferenceAsset[] = [];
      const resolved = new Map<string, ReferenceAsset[]>();
      for (const part of content) {
        if (part.type !== "reference") {
          inserted.push(part.type === "skill" && !skillsEnabled ? {type: "text", text: `/${part.name}`} : part);
          continue;
        }
        const key = JSON.stringify([
          part.assetId,
          part.nodeId,
          part.referenceId,
          part.sourceRole,
          part.fingerprint,
          part.binding,
        ]);
        let assets = resolved.get(key);
        if (!assets) {
          assets = await onPasteReference(part, abort.signal);
          resolved.set(key, assets);
        }
        abort.signal.throwIfAborted();
        for (const asset of assets) {
          added.push(asset);
          inserted.push(referencePart(asset));
        }
      }
      if (!alive.current || abort.signal.aborted || current.current !== before)
        return;
      // Validate the entire paste before changing the document or its graph.
      referenceInsertion(
        [],
        { start: 0, end: 0 },
        [...new Map(added.map((asset) => [asset.id, asset])).values()],
        [...latest.current.assets, ...added],
        rules,
        false,
        t,
      );
      const end = at.start + editingText(inserted).length;
      publish(
        editContent(before, at, inserted),
        { start: end, end },
        true,
        false,
        added,
      );
    } catch (error) {
      if (alive.current && !abort.signal.aborted)
        setNotice((error as Error).message);
    } finally {
      choosing.current = false;
      if (preparation.current === abort) preparation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  function undo(redo: boolean) {
    const from = redo ? future : past,
      to = redo ? past : future;
    const snapshot = from.current.at(-1);
    if (!snapshot) return;
    try {
      latest.current.onChange(snapshot.content);
    } catch (error) {
      setNotice((error as Error).message);
      return;
    }
    from.current.pop();
    to.current.push({ content: current.current, caret: caret() });
    current.current = snapshot.content;
    paint(snapshot.content, snapshot.caret);
    lastEdit.current = 0;
    close();
  }
  function input() {
    if (!root.current || composing.current || choosing.current) return;
    publish(readDOM(root.current), caret(), false, true);
    updateMention();
  }
  function removeReference(direction: "backward" | "forward") {
    const at = caret(),
      text = editingText(current.current);
    const start =
      at.start === at.end && direction === "backward"
        ? Math.max(0, at.start - 1)
        : at.start;
    const end =
      at.start === at.end && direction === "forward"
        ? Math.min(text.length, at.end + 1)
        : at.end;
    if (!text.slice(start, end).includes("\ufffc")) return false;
    publish(editContent(current.current, { start, end }, []), {
      start,
      end: start,
    });
    close();
    return true;
  }
  useImperativeHandle(ref, () => ({
    focus,
    caret,
    setSkill: (name, fromSlash = false) => {
      if (disabled || !skillsEnabled) return;
      const range = fromSlash ? slash.current : caret();
      if (!range) return;
      let offset = 0, removedBeforeStart = 0, removedBeforeEnd = 0;
      const body = current.current.filter(part => {
        const start = offset;
        offset += part.type === "text" ? part.text.length : 1;
        if (part.type !== "skill") return true;
        if (start < range.start) removedBeforeStart++;
        if (start < range.end) removedBeforeEnd++;
        return false;
      });
      const at = {start: range.start - removedBeforeStart, end: range.end - removedBeforeEnd};
      const inserted: ReferenceContent = name ? [{type: "skill", name}, {type: "text", text: " "}] : [];
      const position = at.start + (name ? 2 : 0);
      publish(editContent(body, at, inserted), {start: position, end: position});
      slash.current = null;
      latest.current.onSlashChange?.(null);
      focus({start: position, end: position});
    },
    insert,
    removeSource: (nodeId) => {
      if (disabled || referencesDisabled || choosing.current) return false;
      const at = caret();
      const removed: number[] = [];
      let offset = 0;
      const next = current.current.filter((part) => {
        const remove =
          part.type === "reference" &&
          part.binding !== "asset" &&
          part.nodeId === nodeId;
        if (remove) removed.push(offset);
        offset += part.type === "text" ? part.text.length : 1;
        return !remove;
      });
      if (!removed.length) return false;
      const position = (point: number) =>
        point - removed.filter((index) => index < point).length;
      const nextCaret = { start: position(at.start), end: position(at.end) };
      if (!publish(next, nextCaret)) return false;
      close();
      focus(nextCaret);
      return true;
    },
    openPicker: () => {
      if (rangeRef.current) {
        close();
        focus();
      } else {
        dismissed.current = null;
        explicitPicker.current = true;
        open(caret());
        focus();
      }
    },
  }));
  useLayoutEffect(() => {
    if (
      JSON.stringify(value) !== JSON.stringify(current.current) ||
      !root.current?.childNodes.length
    ) {
      const at =
        root.current && document.activeElement === root.current
          ? caret()
          : undefined;
      if (editingText(value) === editingText(current.current)) {
        for (const stack of [past, future])
          stack.current = stack.current.map((snapshot) => ({
            ...snapshot,
            content: currentReferences(snapshot.content, assets),
          }));
      } else if (
        value.filter((part) => part.type === "text").map((part) => part.text).join("") ===
        current.current.filter((part) => part.type === "text").map((part) => part.text).join("")
      ) {
        // A chip removal arrives as a new value after the canvas command.
        // Keep that previous content so Ctrl+Z in the prompt restores it.
        past.current.push({ content: current.current, caret: saved.current });
        if (past.current.length > 100) past.current.shift();
        future.current = [];
      } else {
        past.current = [];
        future.current = [];
      }
      current.current = value;
      paint(value, at);
    }
  }, [value, t]);
  useEffect(decorate, [
    assets,
    previews,
    metadataOnlyKinds,
    visibleReferenceNodeIds,
    t,
  ]);
  useLayoutEffect(() => {
    if (!autoGrow || !root.current) return;
    const element = root.current;
    const fit = () => {
      const top = element.scrollTop;
      const minimum =
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--input-min-height"),
        ) || 112;
      element.style.height = "auto";
      element.style.height = `${Math.max(minimum, element.scrollHeight)}px`;
      element.scrollTop = top;
    };
    fit();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === element.clientWidth) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, autoGrow]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      preparation.current?.abort();
    };
  }, []);
  useEffect(() => {
    if ((disabled || referencesDisabled) && !choosing.current) close();
  }, [disabled, referencesDisabled]);
  useLayoutEffect(() => {
    if (!range || !root.current || !panel.current) return;
    const element = panel.current,
      editor = root.current;
    let frame = 0;
    function place() {
      const rect = editor.getBoundingClientRect(),
        width = Math.min(
          440,
          window.innerWidth - 24,
          Math.max(280, rect.width),
        );
      element.style.width = `${width}px`;
      const expanded = editor.closest(
        '.cw-composer-dock[data-expanded="true"]',
      );
      let anchor = rect;
      if (expanded) {
        const selection = document.getSelection();
        if (selection?.focusNode && editor.contains(selection.focusNode)) {
          const caret = document.createRange();
          caret.setStart(selection.focusNode, selection.focusOffset);
          caret.collapse(true);
          const caretRect = caret.getBoundingClientRect();
          if (caretRect.height) anchor = caretRect;
        }
      }
      const top = expanded
        ? Math.max(rect.top, Math.min(rect.bottom, anchor.top))
        : rect.top;
      const bottom = expanded
        ? Math.max(
            top,
            Math.min(rect.bottom, anchor === rect ? rect.top : anchor.bottom),
          )
        : rect.bottom;
      const above = top - 18;
      const below = window.innerHeight - bottom - 18;
      const list = element.querySelector(".cw-reference-mention-list");
      const desiredHeight = Math.min(
        360,
        element.offsetHeight +
          (list ? list.scrollHeight - list.clientHeight : 0),
      );
      const placeAbove = expanded
        ? below < desiredHeight && (above >= desiredHeight || above > below)
        : above >= below;
      element.style.maxHeight = `${Math.min(360, Math.max(100, placeAbove ? above : below))}px`;
      element.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
      element.style.top = `${Math.max(12, placeAbove ? top - element.offsetHeight - 6 : bottom + 6)}px`;
      element.style.visibility = "visible";
      frame = requestAnimationFrame(place);
    }
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !element.contains(event.target) &&
        !editor.contains(event.target)
      )
        close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close();
        focus();
      }
    }
    place();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [Boolean(range)]);
  useEffect(() => {
    panel.current
      ?.querySelector('[aria-selected="true"][role="option"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, effectiveCategory, Boolean(range)]);
  function clipboard(event: React.ClipboardEvent, cut: boolean) {
    if (cut && (disabled || busy)) {
      event.preventDefault();
      return;
    }
    const at = caret();
    if (at.start === at.end) return;
    const selected = editContent(
      editContent(
        current.current,
        { start: at.end, end: editingText(current.current).length },
        [],
      ),
      { start: 0, end: at.start },
      [],
    );
    event.preventDefault();
    event.clipboardData.setData("text/plain", contentText(selected, false, t));
    event.clipboardData.setData(
      CLIPBOARD,
      JSON.stringify({ scope, content: selected }),
    );
    if (cut)
      publish(editContent(current.current, at, []), {
        start: at.start,
        end: at.start,
      });
  }
  return (
    <>
      <span ref={iconTemplates} hidden aria-hidden="true">
        {["image", "video", "audio", "text", "subject"].map((kind) => (
          <CanvasIcon key={kind} name={kind} data-kind={kind} size={20} />
        ))}
      </span>
      <div
        ref={root}
        className={`cw-chat-reference-editor ${className}`}
        contentEditable={!disabled && !busy}
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-disabled={disabled || busy}
        aria-busy={busy}
        data-placeholder={placeholder}
        aria-expanded={Boolean(range)}
        aria-controls={range ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          range && shown[selected] ? `${listId}-${selected}` : undefined
        }
        onCompositionStart={() => {
          composing.current = true;
          slash.current = null;
          latest.current.onSlashChange?.(null);
          close();
          // Uncommitted IME text is already drawn in the editor; the empty
          // prompt must not stay behind it.
          if (root.current) root.current.dataset.empty = "false";
        }}
        onCompositionEnd={() => {
          composing.current = false;
          input();
        }}
        onInput={input}
        onFocus={() => {
          updateMention();
        }}
        onPointerUp={() => {
          close();
          updateMention();
        }}
        onBlur={() => {
          if (!choosing.current) close();
        }}
        onClick={() => {
          if (onConfirmPending && !disabled && !busy && !composing.current)
            onConfirmPending(caret());
        }}
        onBeforeInput={(event) => {
          if (disabled || busy) {
            event.preventDefault();
            return;
          }
          const native = event.nativeEvent as InputEvent;
          if (
            native.inputType === "historyUndo" ||
            native.inputType === "historyRedo"
          ) {
            event.preventDefault();
            undo(native.inputType === "historyRedo");
          } else if (
            !native.isComposing &&
            !composing.current &&
            // React can forward textInput events without InputEvent fields.
            native.inputType?.startsWith("delete") &&
            root.current &&
            blankContent(readDOM(root.current))
          ) {
            // Nothing to delete: leaving the browser to act would replace the
            // zero-width anchor with a line break, dropping the prompt and
            // adding a second empty line. Backspace is not input.
            event.preventDefault();
          } else if (
            !native.isComposing &&
            (native.inputType === "deleteContentBackward" ||
              native.inputType === "deleteContentForward") &&
            removeReference(
              native.inputType === "deleteContentBackward"
                ? "backward"
                : "forward",
            )
          )
            event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && busy) {
            event.preventDefault();
            event.stopPropagation();
            preparation.current?.abort();
            return;
          }
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          if (event.key !== "Escape") event.stopPropagation();
          if (disabled || busy) {
            event.preventDefault();
            return;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            ["z", "y"].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            undo(event.shiftKey || event.key.toLowerCase() === "y");
            return;
          }
          if (
            range &&
            [
              "ArrowUp",
              "ArrowDown",
              "ArrowLeft",
              "ArrowRight",
              "Enter",
              "Escape",
            ].includes(event.key)
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") close();
            else if (event.key === "Enter") {
              if (shown[selected]) void choose(shown[selected]);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown")
              setActive(
                shown.length
                  ? (selected +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      shown.length) %
                      shown.length
                  : 0,
              );
            else {
              const index = categories.indexOf(effectiveCategory);
              setCategory(
                categories[
                  (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    categories.length) %
                    categories.length
                ],
              );
              setActive(0);
            }
            return;
          }
          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            removeReference(event.key === "Backspace" ? "backward" : "forward")
          ) {
            event.preventDefault();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (
              (submitOnEnter || event.ctrlKey || event.metaKey) &&
              !event.shiftKey
            )
              onSubmit();
            else {
              const at = caret(),
                end = at.start + 1;
              publish(
                editContent(current.current, at, [
                  { type: "text", text: "\n" },
                ]),
                { start: end, end },
              );
            }
          }
        }}
        onCopy={(event) => clipboard(event, false)}
        onCut={(event) => clipboard(event, true)}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) event.preventDefault();
        }}
        onPaste={(event) => {
          event.preventDefault();
          if (disabled || busy) return;
          if (event.clipboardData.files.length) {
            saved.current = caret();
            onPasteFiles([...event.clipboardData.files]);
            return;
          }
          let inserted: ReferenceContent = [
            { type: "text", text: event.clipboardData.getData("text/plain") },
          ];
          try {
            const data = JSON.parse(event.clipboardData.getData(CLIPBOARD));
            if (
              data.scope === scope &&
              Array.isArray(data.content) &&
              data.content.length <= 2000 &&
              data.content.every((part: ReferenceContent[number]) =>
                part.type === "text"
                  ? typeof part.text === "string"
                  : part.type === "skill" ? typeof part.name === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(part.name)
                  : part.type === "reference" &&
                    typeof part.name === "string" &&
                    part.name.length > 0 &&
                    part.name.length <= 255 &&
                    typeof part.assetId === "string" &&
                    (Boolean(onPasteReference) ||
                      latest.current.assets.some(
                        (asset) =>
                          asset.id === part.assetId &&
                          (!part.fingerprint ||
                            fingerprintMatches(asset, part.fingerprint)),
                      )),
              )
            ) {
              if (
                onPasteReference &&
                (rebindOnPaste ||
                  data.content.some(
                    (part: ReferenceContent[number]) =>
                      part.type === "reference" &&
                      !latest.current.assets.some(
                        (asset) => asset.id === part.assetId,
                      ),
                  ))
              ) {
                void pasteReferences(normalizeContent(data.content), caret());
                return;
              }
              inserted = normalizeContent(data.content.map((part: ReferenceContent[number]) => part.type === "skill" && !skillsEnabled ? {type: "text", text: `/${part.name}`} : part));
            }
          } catch {
            /* Foreign clipboard data is inserted as plain text. */
          }
          const at = caret(),
            end = at.start + editingText(inserted).length;
          publish(editContent(current.current, at, inserted), {
            start: end,
            end,
          });
          updateMention();
        }}
      />
      {notice && (
        <p className="cw-reference-mention-notice" role="alert">
          {notice}
        </p>
      )}
      {range &&
        createPortal(
          <div
            ref={panel}
            className="cw-reference-mention-picker nodrag nopan nowheel"
            role="dialog"
            aria-label={t("assistant.reference.picker")}
            aria-busy={busy}
            style={{ visibility: "hidden" }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onMouseDown={(event) => event.preventDefault()}
            onKeyDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <header>
              <strong>{t("assistant.reference.picker")}</strong>
              <small>{t("assistant.reference.pickerHint")}</small>
            </header>
            <div role="tablist" aria-label={t("assistant.reference.categories")}>
              {REFERENCE_CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  tabIndex={-1}
                  role="tab"
                  aria-selected={effectiveCategory === item.id}
                  disabled={!categories.includes(item.id) || busy}
                  onClick={() => {
                    setCategory(item.id);
                    setActive(0);
                  }}
                >
                  {t(CATEGORY_LABELS[item.id])}
                </button>
              ))}
            </div>
            <div
              role="listbox"
              id={listId}
              aria-label={t("assistant.reference.available")}
              className="cw-reference-mention-list"
            >
              {loading ? (
                <p role="status">{t("assistant.reference.loading")}</p>
              ) : loadError ? (
                <p role="alert">
                  {loadError}{" "}
                  <button type="button" onClick={onOpen}>
                    {t("assistant.reference.reload")}
                  </button>
                </p>
              ) : !shown.length ? (
                <p>{t("assistant.reference.empty")}</p>
              ) : (
                shown.map((option, index) => (
                  <button
                    key={option.id}
                    id={`${listId}-${index}`}
                    type="button"
                    tabIndex={-1}
                    role="option"
                    aria-selected={selected === index}
                    aria-disabled={!!option.disabledReason || busy}
                    title={option.disabledReason ?? option.title}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void choose(option)}
                  >
                    <span className="cw-reference-mention-thumbnail">
                      {option.thumbnail ? (
                        <img src={option.thumbnail} alt="" draggable={false} />
                      ) : (
                        <CanvasIcon name={option.kind} size={22} />
                      )}
                    </span>
                    <span>
                      <strong>{option.title}</strong>
                      <small>{option.disabledReason || option.detail}</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
