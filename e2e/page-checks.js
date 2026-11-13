// biome-ignore-all lint: shared audit file, copied as is from the workshop template
// Runs inside the browser. The spec loads this file, then calls textAudit.run().
// Each check returns a list of plain sentences, one per problem. An empty list means it passed.

const BUTTON_VERBS = [
  "add",
  "back",
  "book",
  "browse",
  "cancel",
  "change",
  "check",
  "choose",
  "clear",
  "close",
  "compare",
  "continue",
  "copy",
  "create",
  "delete",
  "download",
  "edit",
  "email",
  "export",
  "filter",
  "find",
  "follow",
  "get",
  "hide",
  "import",
  "join",
  "load",
  "log",
  "next",
  "open",
  "pay",
  "pick",
  "previous",
  "print",
  "read",
  "refresh",
  "remove",
  "rename",
  "reply",
  "report",
  "request",
  "reset",
  "retry",
  "review",
  "run",
  "save",
  "search",
  "see",
  "select",
  "send",
  "show",
  "sign",
  "sort",
  "start",
  "stop",
  "take",
  "track",
  "try",
  "upload",
  "view",
];
const BARE_BUTTON_WORDS = ["ok", "submit", "go", "apply", "ask", "validate", "approve", "reject"];
const BANNED_ERROR_WORDS =
  /\b(oops|something went wrong|invalid|illegal|fatal|exception|undefined)\b/i;
const BROKEN_VALUES = /\b(undefined|null|NaN)\b|\[object Object\]/;
const SNAKE_CASE_ONLY = /^[a-z]+(_[a-z0-9]+)+$/;
const BARE_ID =
  /^([A-Za-z]{1,3}[-_]?\d{2,}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{16,})$/;
const MODEL_NAMES = /\b(claude[-\w.]*|gpt-[\w.-]+|gemini[-\w.]*|sonnet|opus|haiku|llama[-\w.]*)\b/i;
const TOKEN_COUNT = /\d[\d,.]*\s*k?\s*(input |output |total )?tokens?\b/i;
const RUN_COST = /(cost|spent|price)[^.\n]{0,30}\$\s*\d|\$\s*\d+\.\d{3,}/i;
const HOST_NAME = /\b(localhost|127\.0\.0\.1|[\w-]+\.(internal|local))\b/i;
const NOT_TEXT_INPUTS = ["hidden", "submit", "button", "image", "reset"];

function isVisible(element) {
  if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function visibleElements(selector) {
  return [...document.querySelectorAll(selector)].filter(isVisible);
}

function textOf(element) {
  return (element.innerText || "").replace(/\s+/g, " ").trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function nameOf(element) {
  const text = textOf(element).slice(0, 40);
  return `<${element.tagName.toLowerCase()}> "${text}"`;
}

function sentenceCount(text) {
  return text.split(/[.!?]+(\s|$)/).filter((part) => part && part.trim()).length;
}

function buttonLabel(button) {
  return textOf(button) || button.value || button.getAttribute("aria-label") || "";
}

function noEllipsis() {
  const selector =
    "button, a, h1, h2, h3, h4, h5, h6, label, [role=status], [role=button], .status";
  const found = visibleElements(selector).filter((element) => /…|\.\.\./.test(textOf(element)));
  return found.map((element) => `${nameOf(element)} has an ellipsis. Write the full words.`);
}

function isClipped(element) {
  const style = getComputedStyle(element);
  const hidesSideways = style.textOverflow === "ellipsis" || style.overflowX === "hidden";
  const sidewaysClip = hidesSideways && element.scrollWidth > element.clientWidth + 1;
  const clamped = style.webkitLineClamp !== "none" && style.webkitLineClamp !== "";
  const clampClip = clamped && element.scrollHeight > element.clientHeight + 1;
  return textOf(element) !== "" && (sidewaysClip || clampClip);
}

function noClippedText() {
  const clipped = visibleElements("body *").filter(isClipped);
  return clipped.map((element) => `${nameOf(element)} is cut off. Let it wrap.`);
}

function buttonProblem(button, extraVerbs) {
  const label = buttonLabel(button);
  const words = label.toLowerCase().split(/\s+/).filter(Boolean);
  const verbs = BUTTON_VERBS.concat(extraVerbs);
  if (words.length === 1 && BARE_BUTTON_WORDS.includes(words[0])) {
    return `Button "${label}" is one vague word. Say what it does and to what.`;
  }
  if (words.length < 2 || words.length > 5) {
    return `Button "${label}" has ${words.length} words. Use a verb plus an object, 2 to 5 words.`;
  }
  const verb = words[0].replace(/[^a-z]/g, "");
  if (!verbs.includes(verb)) return `Button "${label}" does not start with a verb.`;
  return "";
}

function buttonsSayWhatTheyDo(options) {
  const selector = "button, [role=button], input[type=button], input[type=submit]";
  const buttons = visibleElements(selector);
  return buttons.map((button) => buttonProblem(button, options.extraVerbs)).filter(Boolean);
}

function errorProblem(element) {
  const text = textOf(element);
  const hasNextStep = element.querySelector("a, button") !== null;
  const sentences = sentenceCount(text);
  if (BANNED_ERROR_WORDS.test(text)) return `Error "${text}" uses a vague or technical word.`;
  if (sentences >= 2 || (sentences === 1 && hasNextStep)) return "";
  return `Error "${text}" does not say what to do next. Add a second sentence or a link.`;
}

function errorsSayWhatNext() {
  const errors = visibleElements("[role=alert], .error").filter((element) => textOf(element));
  return errors.map(errorProblem).filter(Boolean);
}

function emptyStateProblem(element) {
  const text = textOf(element);
  const hasAction = element.querySelector("a, button, code") !== null;
  if (wordCount(text) >= 4 && hasAction) return "";
  return `Empty state "${text}" needs a sentence and a link, button or command.`;
}

function isEmptyList(element) {
  const itemSelector = element.tagName === "TABLE" ? "tbody tr" : "li, [role=listitem]";
  const hasState = element.querySelector("[data-empty-state]") !== null;
  return element.querySelector(itemSelector) === null && !hasState;
}

function emptyStatesGuide() {
  const present = visibleElements("[data-empty-state]").map(emptyStateProblem);
  const lists = visibleElements("ul, ol, table, [role=list]").filter(isEmptyList);
  const neighbours = (list) => list.parentElement.querySelector("[data-empty-state]") === null;
  const missing = lists
    .filter(neighbours)
    .map((list) => `Empty ${nameOf(list)} has no data-empty-state message.`);
  return present.filter(Boolean).concat(missing);
}

function brokenValues() {
  const lines = document.body.innerText.split("\n");
  return lines
    .filter((line) => BROKEN_VALUES.test(line))
    .map((line) => `Page shows "${line.trim()}".`);
}

function rawCodeProblems() {
  const labelled = visibleElements("button, h1, h2, h3, h4, [role=button]");
  const cells = visibleElements("td, th");
  const snake = labelled.concat(cells).filter((element) => SNAKE_CASE_ONLY.test(textOf(element)));
  const ids = labelled.filter((element) => BARE_ID.test(textOf(element)));
  const snakeMessages = snake.map(
    (element) => `${nameOf(element)} is a code name. Write it as words.`,
  );
  const idMessages = ids.map((element) => `${nameOf(element)} is only an id. Add what it is.`);
  return snakeMessages.concat(idMessages);
}

function noRawCodes() {
  return brokenValues().concat(rawCodeProblems());
}

function noOperatorDetail() {
  if (document.body.dataset.audience === "staff") return [];
  const text = document.body.innerText;
  const patterns = [MODEL_NAMES, TOKEN_COUNT, RUN_COST, HOST_NAME];
  const hits = patterns.map((pattern) => text.match(pattern)).filter(Boolean);
  return hits.map((hit) => `Public page shows "${hit[0]}". Staff detail belongs on a staff page.`);
}

function tooltipsStayShort() {
  const tips = [...document.querySelectorAll("[title], [role=tooltip]")];
  const text = (tip) => tip.getAttribute("title") || tip.textContent.trim();
  const tooLong = tips.filter((tip) => wordCount(text(tip)) > 15);
  return tooLong.map((tip) => `Tooltip "${text(tip).slice(0, 40)}" is over 15 words.`);
}

function accessibleName(field) {
  const labels = [...(field.labels || [])].map((label) => label.textContent.trim());
  const labelledBy = (field.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  const referenced = labelledBy.map((id) => document.getElementById(id)?.textContent.trim() || "");
  const own = field.getAttribute("aria-label") || "";
  return labels.concat(referenced, [own]).join("").trim();
}

function inputsAreLabelled() {
  const fields = visibleElements("input, select, textarea");
  const needsLabel = fields.filter((field) => !NOT_TEXT_INPUTS.includes(field.type));
  const unnamed = needsLabel.filter((field) => accessibleName(field) === "");
  return unnamed.map(
    (field) =>
      `A ${field.tagName.toLowerCase()} has no visible label. A placeholder is not a label.`,
  );
}

function noSidewaysScroll() {
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth <= width) return [];
  const wide = visibleElements("body *").filter(
    (element) => element.getBoundingClientRect().right > width + 1,
  );
  const names = wide.slice(0, 3).map(nameOf).join(", ");
  const page = document.documentElement.scrollWidth;
  return [`Page is ${page}px wide in a ${width}px window. Widest: ${names}.`];
}

function run(options) {
  const settings = { extraVerbs: [], ...options };
  return {
    "1 no ellipsis": noEllipsis(),
    "2 no clipped text": noClippedText(),
    "3 buttons say what they do": buttonsSayWhatTheyDo(settings),
    "4 errors say what next": errorsSayWhatNext(),
    "5 empty states guide": emptyStatesGuide(),
    "6 no raw codes or ids": noRawCodes(),
    "7 no operator detail": noOperatorDetail(),
    "8 tooltips stay short": tooltipsStayShort(),
    "9 inputs are labelled": inputsAreLabelled(),
    "10 no sideways scroll": noSidewaysScroll(),
  };
}

globalThis.textAudit = { run };
