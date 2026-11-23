import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { type PdfPageGeometry, pdfPageViewSize } from "@codenine/shared/pdfGeometry";
import * as Schema from "effect/Schema";
import { TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import { ChevronDownIcon, ChevronUpIcon, MinusIcon, PlusIcon, ScanIcon } from "lucide-react";
import { Input } from "~/components/ui/input";
import { observeResize } from "~/lib/observeResize";
import {
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileToolRow,
} from "./fileSurfaceChrome";
import { DocumentTooLargeError, readBoundedDocument } from "./readBoundedDocument";
import { openPdf } from "./pdfDocument";
import {
  currentPdfPage,
  pdfFindIncludes,
  pdfFindMatchRuns,
  pdfPageOffsets,
  pdfPageScrollTop,
  pdfPageText,
  pdfPageWidth,
  pdfRestoredScrollTop,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  stepPdfZoom,
  visiblePdfPages,
} from "./pdfLayout";
import "./pdfViewer.css";

const MAX_PAGES = 2000;
const isTooLarge = Schema.is(DocumentTooLargeError);
const MAX_FIND_TEXT = 4 * 1024 * 1024;

const MAX_POSITIONS = 50;
type PdfPosition = PdfViewState & { width: number; ratios: readonly number[] };
// Thread switches unmount the preview; retain only the most recent documents.
const positions = new Map<string, PdfPosition>();

export type PdfViewState = {
  page: number;
  offset: number;
  zoom: number | null;
  left: number;
};

/** A page as it is shown, for what a caller lays over it. */
export interface PdfPageSurface {
  readonly index: number;
  readonly geometry: PdfPageGeometry;
  /** The shown page's size in CSS pixels. */
  readonly width: number;
  readonly height: number;
}

export interface PdfViewerHandle {
  readonly showPage: (index: number) => void;
}

/** A link on a page, in CSS pixels from the page's upper left corner. */
interface PdfPageLink {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Where an outside link goes, as pdf.js made it safe to follow. */
  readonly url: string | null;
  /** Where a link inside the document goes. */
  readonly dest: unknown;
}

type PdfViewport = ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["getViewport"]>;

function pageLinks(annotations: ReadonlyArray<unknown>, viewport: PdfViewport) {
  const links: PdfPageLink[] = [];
  for (const annotation of annotations as ReadonlyArray<{
    subtype?: string;
    rect?: number[];
    url?: string;
    dest?: unknown;
  }>) {
    if (annotation.subtype !== "Link" || annotation.rect?.length !== 4) continue;
    const url = typeof annotation.url === "string" ? annotation.url : null;
    const dest = annotation.dest ?? null;
    if (url === null && dest === null) continue;
    const [left = 0, bottom = 0, right = 0, top = 0] = annotation.rect;
    const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(left, bottom) as number[];
    const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(right, top) as number[];
    links.push({
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      url,
      dest,
    });
  }
  return links;
}

function PdfPage(props: {
  document: PDFDocumentProxy;
  index: number;
  width: number;
  query: string;
  onSize: (index: number, ratio: number) => void;
  onError: (error: string) => void;
  /** Follows a link to another place in the document; links are off when it is absent. */
  onFollow: ((dest: unknown) => void) | undefined;
  renderOverlay: ((surface: PdfPageSurface) => ReactNode) | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const { document: pdf, index, width, onSize, onError } = props;
  // The page's stored box and rotation, known once pdf.js has read the page.
  const [frame, setFrame] = useState<Pick<PdfPageGeometry, "box" | "rotation"> | null>(null);
  const [links, setLinks] = useState<ReadonlyArray<PdfPageLink>>([]);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Render the PDF page canvas and text layer, cancelling tasks and releasing pdf.js page resources on cleanup.
  useEffect(() => {
    let cancelled = false;
    let paint: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let layer: TextLayer | undefined;
    let loadedPage: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      loadedPage = page;
      if (cancelled || !canvas.current || !text.current) {
        page.cleanup();
        return;
      }
      const natural = page.getViewport({ scale: 1 });
      onSize(index, natural.height / natural.width);
      const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
      setFrame({ box: [left, bottom, right, top], rotation: page.rotate });
      const viewport = page.getViewport({ scale: width / natural.width });
      const ratio = Math.min(
        2,
        window.devicePixelRatio || 1,
        Math.sqrt((8 * 1024 * 1024) / (viewport.width * viewport.height)),
      );
      canvas.current.width = Math.ceil(viewport.width * ratio);
      canvas.current.height = Math.ceil(viewport.height * ratio);
      paint = page.render({
        canvas: canvas.current,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        background: "white",
      });
      text.current.replaceChildren();
      text.current.style.setProperty("--total-scale-factor", String(viewport.scale));
      layer = new TextLayer({
        container: text.current,
        viewport,
        textContentSource: page.streamTextContent(),
      });
      const [annotations] = await Promise.all([
        page.getAnnotations(),
        paint.promise,
        layer.render(),
      ]);
      if (!cancelled) setLinks(pageLinks(annotations, viewport));
    })().catch((cause: unknown) => {
      if (!cancelled)
        onError(cause instanceof Error ? cause.message : "This PDF page could not render.");
    });
    return () => {
      cancelled = true;
      paint?.cancel();
      layer?.cancel();
      // Release operator lists when virtual pages leave the viewport.
      void Promise.allSettled([paint?.promise]).then(() => loadedPage?.cleanup());
    };
  }, [pdf, index, width, onSize, onError]);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Highlight pdf.js-owned text nodes and observe asynchronous text layer mutations for the current search query.
  useEffect(() => {
    const node = text.current;
    if (!node) return;
    const mark = () => {
      const elements = Array.from(node.querySelectorAll('span[role="presentation"], br'));
      const hits = pdfFindMatchRuns(
        elements.map((element) => (element.tagName === "BR" ? "\n" : (element.textContent ?? ""))),
        props.query,
      );
      elements.forEach((element, index) => element.classList.toggle("pdf-find-match", hits[index]));
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [props.query]);
  let overlay: ReactNode = null;
  if (props.renderOverlay !== undefined && frame !== null) {
    const natural = pdfPageViewSize({ ...frame, scale: 1 });
    const geometry = { ...frame, scale: width / natural.width };
    overlay = props.renderOverlay({ index, geometry, ...pdfPageViewSize(geometry) });
  }
  return (
    <>
      <canvas ref={canvas} aria-label={`Page ${index + 1}`} className="block h-full w-full" />
      <div ref={text} data-pdf-text-layer />
      {props.onFollow === undefined
        ? null
        : links.map((link) => {
            const style = {
              left: link.left,
              top: link.top,
              width: link.width,
              height: link.height,
            };
            const key = `${link.left}:${link.top}:${link.url ?? "inside"}`;
            return link.url !== null ? (
              <a
                key={key}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={link.url}
                className="absolute"
                style={style}
              />
            ) : (
              <button
                key={key}
                type="button"
                aria-label="Go to the linked page"
                className="absolute cursor-pointer"
                style={style}
                onClick={() => props.onFollow?.(link.dest)}
              />
            );
          })}
      {overlay === null ? null : (
        // Clicks fall through to the text under it, except on what the overlay itself offers.
        <div
          data-pdf-box={frame?.box.join(",")}
          data-pdf-rotation={frame?.rotation}
          className="pointer-events-none absolute inset-0"
        >
          {overlay}
        </div>
      )}
    </>
  );
}

export default function PdfViewer(props: {
  src: string;
  title: string;
  positionKey?: string;
  initialView?: PdfViewState;
  onViewChange?: (view: PdfViewState) => void;
  handle?: Ref<PdfViewerHandle>;
  /** Controls before and after the viewer's own in its toolbar. */
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
  /** Lines under the toolbar. */
  header?: ReactNode;
  /** A panel beside the pages. */
  side?: ReactNode;
  /** What to lay over each shown page, such as highlights and form inputs. */
  renderPageOverlay?: (surface: PdfPageSurface) => ReactNode;
  /** False while clicks on the page mean something else, as with a tool in hand. */
  links?: boolean;
  /** The document is beyond what this viewer loads: too large, too many pages or too slow. */
  onUnavailable?: () => void;
}) {
  const [savedPosition] = useState(() =>
    props.positionKey === undefined ? undefined : positions.get(props.positionKey),
  );
  const [initialView] = useState<PdfViewState>(
    () => savedPosition ?? props.initialView ?? { page: 0, offset: 0, zoom: null, left: 0 },
  );
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [ratios, setRatios] = useState<readonly number[]>([]);
  const [zoom, setZoom] = useState(initialView.zoom);
  const [pageWidth, setPageWidth] = useState(612);
  const [viewport, setViewport] = useState({ width: 600, height: 800 });
  const [scrollTop, setScrollTop] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [match, setMatch] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const zoomAnchor = useRef<{ page: number; offset: number; width: number } | null>(null);
  const initialPage = initialView.page;
  const restored = useRef(false);
  const reportUnavailable = useEffectEvent(() => props.onUnavailable?.());
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Own the PDF fetch, load timeout, and pdf.js document task across source changes, retries, and unmounts.
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let task: ReturnType<typeof openPdf> | undefined;
    // A document that is shown is released when another replaces it, not when this load ends.
    let shown = false;
    const timeout = setTimeout(() => {
      setError("This PDF took too long to load. Try again.");
      reportUnavailable();
      controller.abort();
      void task?.destroy();
    }, 30_000);
    void readBoundedDocument(
      props.src,
      controller.signal,
      50 * 1024 * 1024,
      revision > 0 ? "reload" : "default",
    )
      .then(async (bytes) => {
        controller.signal.throwIfAborted();
        task = openPdf(bytes);
        const document = await task.promise;
        if (document.numPages > MAX_PAGES) {
          reportUnavailable();
          throw new Error("Preview limited to 2,000 pages. Save this PDF to read it in full.");
        }
        const first = (await document.getPage(1)).getViewport({ scale: 1 });
        const sizes = await Promise.all(
          Array.from({ length: Math.min(initialPage + 1, document.numPages) }, async (_, index) => {
            const size = (await document.getPage(index + 1)).getViewport({ scale: 1 });
            return size.height / size.width;
          }),
        );
        if (controller.signal.aborted) return;
        setPageWidth(first.width);
        // A new revision of the document on screen keeps the layout it is read in.
        setRatios((old) =>
          old.length === document.numPages
            ? old
            : savedPosition?.ratios.length === document.numPages
              ? savedPosition.ratios
              : Array.from(
                  { length: document.numPages },
                  (_, index) => sizes[index] ?? first.height / first.width,
                ),
        );
        shown = true;
        setError(null);
        setPdf(document);
      })
      .catch((cause: unknown) => {
        if (disposed || controller.signal.aborted) return;
        if (isTooLarge(cause)) reportUnavailable();
        setError(cause instanceof Error ? cause.message : "Unable to open PDF.");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      if (!shown) void task?.destroy();
    };
  }, [props.src, revision, initialPage, savedPosition]);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Release a pdf.js document once another has replaced it on screen or the viewer has gone, so the pages stay up while a new revision loads.
  useEffect(() => {
    if (!pdf) return;
    return () => void pdf.loadingTask.destroy();
  }, [pdf]);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Measure the PDF viewport before paint and observe resizes for fit-width sizing and visible-page selection.
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    update();
    return observeResize(node, update);
  }, []);
  const { scale, width } = pdfPageWidth(viewport.width, pageWidth, zoom);
  const offsets = pdfPageOffsets(ratios, width);
  const current = currentPdfPage(offsets, ratios.length, scrollTop);
  const visible = visiblePdfPages(ratios, offsets, scrollTop, viewport.height);
  // Stable callbacks let page canvases survive scroll and find updates.
  const [onSize] = useState(
    () => (index: number, ratio: number) =>
      setRatios((old) =>
        old[index] === ratio ? old : old.map((value, i) => (i === index ? ratio : value)),
      ),
  );
  const jumpToPage = useEffectEvent((index: number) => {
    scroll.current?.scrollTo({ top: pdfPageScrollTop(offsets, index) });
  });
  const saveView = (node: HTMLDivElement, notify = true) => {
    const page = currentPdfPage(offsets, ratios.length, node.scrollTop);
    if (!pdf) return;
    const view = {
      page,
      offset: Math.max(0, node.scrollTop - (offsets[page]! - 16)),
      zoom,
      left: node.scrollLeft,
    };
    if (notify) props.onViewChange?.(view);
    if (props.positionKey !== undefined) {
      positions.delete(props.positionKey);
      positions.set(props.positionKey, { ...view, width, ratios });
      const oldest = positions.keys().next();
      if (positions.size > MAX_POSITIONS && !oldest.done) positions.delete(oldest.value);
    }
  };
  const restoreView = useEffectEvent(() => {
    const node = scroll.current;
    if (!pdf || !node) return;
    node.scrollTo({
      top: pdfRestoredScrollTop(ratios, width, initialView, savedPosition?.width),
      left: initialView.left,
    });
    setScrollTop(node.scrollTop);
    saveView(node);
  });
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Restore the saved PDF scroll position after the loaded document's page layout commits.
  useLayoutEffect(() => {
    // Only the first document of a mount: a later revision is read where the reader already is.
    if (!pdf || restored.current) return;
    restored.current = true;
    restoreView();
  }, [pdf]);
  const showPage = (index: number) => {
    scroll.current?.scrollTo({ top: pdfPageScrollTop(offsets, index) });
  };
  // Rebuilt each render so that it scrolls by the page offsets now on screen.
  useImperativeHandle(props.handle, () => ({ showPage }));
  const follow = (dest: unknown) => {
    if (!pdf) return;
    void (async () => {
      const explicit: unknown = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      const target: unknown = Array.isArray(explicit) ? explicit[0] : null;
      if (typeof target === "number") return target;
      if (typeof target !== "object" || target === null) return null;
      return pdf.getPageIndex(target as Parameters<typeof pdf.getPageIndex>[0]);
    })().then(
      (index) => {
        if (index !== null) showPage(index);
      },
      // A link to a page the document does not have goes nowhere.
      () => {},
    );
  };
  const changeZoom = (value: number | null) => {
    zoomAnchor.current = {
      page: current,
      offset: (scroll.current?.scrollTop ?? 0) - (offsets[current]! - 16),
      width,
    };
    setZoom(value);
  };
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Restore the DOM scroll anchor after the new zoom width has committed to page layout.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    const node = scroll.current;
    if (!node || !pdf) return;
    if (anchor && anchor.width !== width) {
      node.scrollTo({
        top: offsets[anchor.page]! - 16 + (anchor.offset * width) / anchor.width,
      });
    }
    saveView(node, anchor !== null);
  });
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Scroll to the first asynchronous search result after its measured page offsets have committed.
  useLayoutEffect(() => {
    if (matches.length) jumpToPage(matches[0]!);
  }, [matches]);
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- Debounce pdf.js text extraction and cancel obsolete searches when the query or document changes.
  useEffect(() => {
    if (!pdf || !query.trim()) {
      // oxlint-disable-next-line react/set-state-in-effect -- A blank query cancels the previous search.
      setFinding(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setFinding(true);
      setFindError(null);
      setMatches([]);
      setMatch(0);
      void (async () => {
        const found: number[] = [];
        const sizes: number[] = [];
        let size = 0;
        for (let index = 0; index < pdf.numPages; index++) {
          if (cancelled) return;
          const page = await pdf.getPage(index + 1);
          const pageSize = page.getViewport({ scale: 1 });
          sizes.push(pageSize.height / pageSize.width);
          const content = await page.getTextContent();
          const text = pdfPageText(content.items);
          size += text.length;
          if (size > MAX_FIND_TEXT)
            throw new Error(
              "This PDF has too much text to search. Save it to search in another app.",
            );
          if (pdfFindIncludes(text, query)) found.push(index);
        }
        if (cancelled) return;
        setRatios(sizes);
        setMatches(found);
      })()
        .catch((cause: unknown) => {
          if (!cancelled)
            setFindError(cause instanceof Error ? cause.message : "Could not search this PDF.");
        })
        .finally(() => {
          if (!cancelled) setFinding(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pdf, query]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <FileToolRow label="PDF tools" wrap>
        {props.toolbarStart}
        <span className="mr-auto px-1 tabular-nums" aria-live="polite">
          {pdf ? `${current + 1} / ${pdf.numPages} pages` : "PDF"}
        </span>
        <FileSurfaceAction
          label="Previous page"
          disabled={!pdf || current === 0}
          onPress={() => showPage(current - 1)}
        >
          <ChevronUpIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Next page"
          disabled={!pdf || current + 1 >= pdf.numPages}
          onPress={() => showPage(current + 1)}
        >
          <ChevronDownIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Zoom out"
          disabled={scale <= PDF_MIN_ZOOM}
          onPress={() => changeZoom(stepPdfZoom(scale, -1))}
        >
          <MinusIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="min-w-14 text-center tabular-nums">
          {zoom === null ? "Fit width" : `${Math.round(scale * 100)}%`}
        </span>
        <FileSurfaceAction
          label="Zoom in"
          disabled={scale >= PDF_MAX_ZOOM}
          onPress={() => changeZoom(stepPdfZoom(scale, 1))}
        >
          <PlusIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Fit width"
          onPress={() => {
            changeZoom(null);
            scroll.current?.scrollTo({ left: 0 });
          }}
        >
          <ScanIcon className="size-3.5" />
        </FileSurfaceAction>
        <div className="w-28">
          <Input
            ref={find}
            size="compact"
            type="search"
            aria-label="Find in PDF"
            placeholder="Find in PDF"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatches([]);
              setFindError(null);
            }}
          />
        </div>
        {query ? (
          <>
            <span role="status">
              {finding
                ? "Searching…"
                : (findError ?? `${matches.length ? match + 1 : 0}/${matches.length}`)}
            </span>
            <FileSurfaceAction
              label="Next matching page"
              disabled={!matches.length}
              onPress={() => {
                const next = (match + 1) % matches.length;
                setMatch(next);
                showPage(matches[next]!);
              }}
            >
              <ChevronDownIcon className="size-3.5" />
            </FileSurfaceAction>
          </>
        ) : null}
        {props.toolbarEnd}
      </FileToolRow>
      {props.header}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={scroll}
          role="region"
          aria-label={props.title}
          tabIndex={0}
          className="relative min-h-0 min-w-0 w-full flex-1 overflow-auto scrollbar-gutter-stable bg-muted/40"
          onScroll={(event) => {
            const top = event.currentTarget.scrollTop;
            setScrollTop(top);
            saveView(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "f") {
              event.preventDefault();
              event.stopPropagation();
              find.current?.focus();
            }
          }}
        >
          {error ? (
            <FileSurfaceFailure
              message={error}
              onRetry={() => {
                setError(null);
                setPdf(null);
                restored.current = false;
                setRevision((value) => value + 1);
              }}
            />
          ) : !pdf ? (
            <FileSurfaceLoading />
          ) : (
            <div
              className="relative"
              style={{
                height: `max(${offsets.at(-1) ?? 0}px, calc(100% + ${(offsets.at(-2) ?? 16) - 16}px))`,
                minWidth: width + 32,
              }}
            >
              {visible.map(({ index, ratio }) => (
                <div
                  key={index}
                  data-pdf-page={index}
                  className="absolute bg-white shadow-sm"
                  style={
                    {
                      top: offsets[index],
                      left: Math.max(16, (viewport.width - width) / 2),
                      width,
                      height: width * ratio,
                      "--total-scale-factor": 1,
                    } as CSSProperties
                  }
                >
                  <PdfPage
                    document={pdf}
                    index={index}
                    width={width}
                    query={query}
                    onSize={onSize}
                    onError={setError}
                    onFollow={props.links === false ? undefined : follow}
                    renderOverlay={props.renderPageOverlay}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {props.side}
      </div>
    </div>
  );
}
