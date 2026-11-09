# Markdown view

The editor a `.md` doc opens in: the Markdown file as its text, drawn
formatted, with the syntax shown only where the caret is (live preview). It
is one view ([Views](architecture.md#views)); switched off, Markdown opens in
the plain view as source.

## Principles

1. **The file is Markdown, and the view edits it.** The editor's text is the
   file's text: what is shown is what is saved, and nothing is rewritten.
   A block no one changed keeps its bytes because nothing touches it.
2. **Format as you type, or with the toolbar.** Typed `**x**` is bold, as
   in any Markdown editor; the toolbar and its keys type the same syntax.
3. **The page is the writer's.** Tools sit at its edges; nothing but the
   text and the marks of others is drawn in it.
4. **Every mark is someone's.** A comment, a revision and a cursor each show
   whose it is, in that teammate's color.
5. **Text in, text out.** The view takes and gives the doc's text, and is
   told in offsets on it what to draw. It knows no one, no file and no rule.

## UX

### Writing

- All of CommonMark and GFM, and footnotes as GitHub writes them
  ([#358](https://github.com/ponjo-app/ponjo/issues/358) lists each).
  Syntax outside them (math, `==highlight==`, wiki links) is text.
- **Live preview.** Text is drawn formatted and its syntax is hidden, except
  where it is being edited, as in Typora: a span's (bold, a link, code)
  while the selection touches it, faded; a block's markers on the lines the
  selection touches, hanging in the margin (`#`, `>`) or in the box its
  bullet takes, so the text does not move; a table is edited as a grid
  (below), and shows as its source whole only with the selection in its
  text (a match found there, or Edit as Markdown). As a doc opens, before the person is in it,
  nothing is source; after, what the selection touches stays source when
  the editor loses the focus too, as the caret stays drawn. An earlier
  version, read-only, is drawn whole:

  | Block or span | Away from the selection | Being edited |
  | --- | --- | --- |
  | Bold, italic, strikethrough (`~~` or `~`), inline code | formatted; the marks hidden | the span the selection touches: formatted, its marks faded |
  | Heading (`#`, or underlined with `===`/`---`) | large; `# ` hidden, an underline faded | `# ` faded, in the margin |
  | Link, inline or by reference | its text, as a link; the rest hidden. A `[text]` no definition names is text | touched, the whole source |
  | Autolink (`<https://…>`, `www.…`, an email) | a link; `<>` hidden | touched, `<>` faded |
  | Link definition (`[ref]: url`) | muted | the same |
  | Bullet list | a dot for `-`, `*`, `+`; each level indented; a wrapped line hangs under the item's text | the marker, in the dot's place |
  | Ordered list (`1.`, `1)`) | the number as typed, indented the same | the same |
  | Task list | a checkbox, ticked by a click, which types `x` or a space; a done item struck through | the checkbox, `- ` in the margin |
  | Quote | a bar at the left per level; `>` hidden | `>` faded, in the margin |
  | Code block, fenced or indented | monospace on a tint, coloured by its language; its fences hidden, their lines its padding | its fences, faded |
  | Rule (`---`, `***`, `___`) | a line | the source |
  | Image, inline or by reference | the image | touched, the source |
  | Table | the table, drawn, with its cells' formatting and alignment; a header with no text left out | the grid, a cell at a time; with the selection in its text, the source, monospace, pipes faded |
  | Mermaid block | its diagram | the source |
  | Footnote (`[^1]`, `[^1]: …`) | a superscript number, in the order of first use; the note small, with its number | a reference touched, a note on its lines: the source |
  | Paragraph wrapped by hand (a soft break: a line break, not a hard one) | one flowing paragraph, each soft break the space it reads as | on its lines: its lines as written |
  | Hard break (a line ending in `\` or two spaces) | the break; `\` hidden | touched, `\` shows |
  | Escape (`\*`), entity (`&copy;`) | the character | touched, the source |
  | Front matter, raw HTML | the source, muted | the same |
- **Typed Markdown formats**, as it is typed. There is no other conversion:
  the characters typed are the characters saved.
- **The toolbar** is icons in five groups, and shows the formatting at the
  caret (its buttons pressed, the block's style named):

  | Group | Tools |
  | --- | --- |
  | History | Undo, Redo |
  | Text style, a menu | Normal text, Heading 1–3, Quote, Code block, each with its Markdown (`#`, `>`, ```` ``` ````) |
  | Inline | Bold, Italic, Strikethrough, Inline code, Link |
  | Lists | Bulleted, Numbered, Task |
  | Insert (+), a menu | Table, Divider, Footnote |

  A tool's tooltip says its name and keys. Each types or removes the syntax:
  bold wraps the selection in `**` (or unwraps it), a style sets the prefix
  of each line the selection touches (Normal text takes it away), a code
  block fences them, a table puts in two columns and a row, a footnote puts
  `[^n]` at the caret and its note at the doc's end, with the caret there.
  The standard keys do the same: Mod+B bold, Mod+I italic, Mod+E inline
  code, Mod+Shift+X strikethrough, Mod+K a link; and for the block styles,
  as Google Docs keys them (Mod+digit is a browser's tabs): Mod+Alt+0 Normal
  text, Mod+Alt+1–3 Heading 1–3, Mod+Alt+Q Quote, Mod+Alt+C Code block,
  Mod+Shift+7 Numbered, Mod+Shift+8 Bulleted, Mod+Shift+9 Task. The Task and Footnote icons
  are new to the design system (`site/design.html`, `web/icons.js`).
- **Paste.** Formatted text (from a web page, a doc, another editor) is
  turned into Markdown once, as it is pasted, so what shows is what is
  saved; images held in the page itself (`data:`) are left out, which would
  put their bytes in the file. Plain text goes in as it is, so pasted
  Markdown formats. Mod+Shift+V pastes the plain text of anything.
  Pasting a URL over selected text links the text.
- **Pairs.** `(`, `[` and `` ` `` type their closer after the caret, and
  `**` its `**` (a `*` typed after one that starts a word); typing the
  closer steps over it, and Backspace in an empty pair takes both. A
  fence's backticks, `***` and `* ` are typed as they are, and in code only
  its language's pairs close. `*`, `_` or `~` typed over a selection wraps it.
- **Blank lines** are lines: as many as are typed, saved as typed.
- **Keys:** Undo, Redo, the formatting above, Comment, Find, and focus mode
  (Ctrl+Shift+.). Enter in a paragraph or a heading starts a new
  paragraph a blank line apart, as in Typora, and Shift+Enter is a new line
  in it. Enter in a list item continues the list (an empty item ends it,
  with a blank line), and in a quote the quote; in a code block it is a new
  line. Backspace right after a list item's marker or a quote's
  takes the marker away, a blank line keeping the line apart from the
  list or quote above it; after a nested item's marker it moves the item
  out a level. Tab and Shift+Tab indent and outdent the lines of a list item
  (by its marker's width) or a code block (by its own indent); in a table's
  source they go to the next cell and the one before. Elsewhere Tab stays in the
  page.
- **Links.** At the caret a card says where a link goes: open it, edit it or
  remove it. The link button opens a popover for the URL: Enter applies, an
  empty URL removes, Escape cancels. Mod+click opens a link; `#heading`
  scrolls to that heading in the doc.
- **Diagrams.** A ` ```mermaid ` block shows as its diagram; with the
  selection in it, as its source, typed into as any text. An AI buddy can
  change it too, asked in a comment.
- **Tables** are edited as a grid. A click on a cell edits it in place:
  its own text, Markdown and all, typed into its range of the doc, a `|`
  typed as `\|`. Tab and Shift+Tab go to the next cell and the one before,
  Enter and the arrows to the cell below or above (past the last row, Tab
  and Enter add one; past the first or the last, the arrows leave the
  table), and Escape leaves it; arrow down from the line above, or up from
  the line below, goes into it. Mod+B, Mod+I and Mod+E wrap what is
  selected in the cell. The ⋯ at its top right inserts and deletes rows
  and columns, aligns a column, or edits it as Markdown. The pipes are
  typed as written, never lined up again: rows no one changed keep their
  bytes. A header with no text shows while the table is edited.
- **Code blocks.** A fenced block names its language at its top right
  (Plain text for none). A click on it opens a list that finds a language
  by name, the common ones first: picking one types it after the fence,
  Enter with none found types what was typed, Escape cancels.
- **Images** in the file show; the view does not insert them. One on the web
  (`https:`) loads from there; one at a path comes from the doc host
  (`image`, as a link resolves, only what the project shows), up to 5 MB.
- **Find and replace** (Mod+F; Mod+Alt+F with Replace), as in every view: a
  bar at the page's top right finds in the doc's text, its syntax included,
  as the plain view does, ignoring case unless Match case is on (and Whole
  word, Regular expression: [Around the doc](user-experience.md#around-the-doc)); every match is marked, the current one stronger, with how
  many there are. Enter or Mod+G goes to the next, Shift for the one before;
  Escape closes it and selects the match. Replace and Replace all are the
  person's own edit, undone with Cmd+Z. A view that cannot be edited finds
  only.
- **Spelling** is checked as the person types, by the system's spell
  checker: the text, not its code, URLs, HTML or front matter. A right-click
  on a misspelt word offers its corrections. An earlier version is not checked.
- **Right to left:** a line of Hebrew or Arabic runs the way its text starts.

### Reading

The view's settings, on its page in Settings > Views:

- **Page:** font (sans, serif or mono) and width (normal or wide).
- **Outline:** a tick per heading at the left edge; hover for the list,
  click to go.
- **Focus mode:** every block but the caret's fades.
- **Word count**, in the toolbar: the words a reader sees, not a link's URL
  or the syntax.

### Others in the doc

- **Comments:** commented text is yellow, the open thread's stronger. A
  bubble over a selection offers Comment.
- **An AI buddy's revision:** when its turn lands, its new text is in its
  color and what it removed is grey and struck through where it was, with
  its name over the change for a moment. It stays until you type, press
  Escape or another turn lands; the count under its reply shows it again.
- **Changes from outside** (`git pull`, another editor) glow for a moment,
  with who made them.
- **Cursors:** an AI buddy's, at the passage it was asked about, with its
  name while it works. A person's, where they type, with their name while
  they move or type. One inside hidden syntax is drawn at its edge.
- **Two people typing:** see [Many writers](#many-writers).

### Earlier versions

History shows a version in the same view, read-only: as nothing there has
the caret, it is drawn fully formatted, diagrams as their source, so a change
in one can be seen.

### Not here

A slash menu, inserting images, and who typed which characters.

## Architecture

### The shape

| Part | File | Does |
| --- | --- | --- |
| Declaration | `web/views/markdown/index.js` | id, extensions, settings; loads the view with the first Markdown doc |
| Editor | `web/views/codemirror.js` | the CodeMirror editor both views are: the contract, marks, others' edits, find, right to left |
| View | `web/views/markdown/view.js` | that editor with Markdown's language (`@codemirror/lang-markdown`, GFM) and the preview |
| Preview | `web/views/markdown/preview.js` | the decorations and widgets of live preview, from the syntax tree, for the lines on screen |
| Chrome | `web/views/markdown/chrome.js` | toolbar, bubble, link card and popover, outline, focus mode, word count |
| Syntax | `web/views/markdown/syntax.js` | what Lezer's Markdown parser leaves out: GFM's single-tilde strikethrough, and footnotes |
| Table | `web/views/markdown/table.js` | a table drawn as a grid, edited a cell at a time |
| Pairs | `web/views/markdown/pairs.js` | brackets, backticks and `**` closed as they are typed |
| Paste | `web/views/markdown/paste.js` | formatted text pasted, as Markdown (Turndown, with its GFM tables) |
| Diagrams | `web/diagrams.js` | a mermaid block as its diagram |
| Find | `web/find.js` | the find bar, the same in every view; the view finds and replaces |

### One text

The editor's document is the doc's text, so an offset on the doc is a
position in the editor: marks, the selection, anchors and others' edits
need no map. The preview is decorations over the text, never a change to
it: the syntax tree (Lezer's, parsed again only where the text changed)
says what each span is; a span the selection touches, and the block
markers of the lines it touches, are drawn as source. Hidden syntax is
atomic: the caret steps over it, and reaches it by moving next to it. A
marker that hangs in the margin is the text itself, positioned there
(`.pj-md-hang`), so the caret and a click reach it as any text. The language is CommonMark and GFM only, with the
extensions in `syntax.js`: CodeMirror's own Markdown would read `~x~` as
subscript, and `^x^` and `:x:` too.

Two things keep a click where it lands. While the pointer is down, what is
drawn stays as it was when it was pressed, and follows the selection once
it is let go: a block drawn as its source under the press (a code block's
fences, a table) takes another height and would move the text being
clicked. And a block drawn in place of its lines (a table, a diagram, an
image) has no margins, which the editor does not measure, only padding.

### Text in, text out

- **In:** `applyText(text, { by, ops })` applies `ops`, the operations that
  made `text`, as one change outside the undo history, glowing with `by`,
  as the plain view does. The caret and the line on top stay.
- **Out:** `getText()` is the editor's text.
- **When:** `onEdit` fires on every change the person makes; `onChange` 200
  ms after they last changed it, for what can wait for a pause (the marks).

### The contract

What every view has, in offsets on the doc's text (`test/views.test.js`):
`getText`, `applyText`, `setMarks` (comments, a revision, cursors), the
selection, `tops` and `scrollTo` (for the margin), `focus`, `undo` and
`redo`, and a call when its settings change. Made with the text, whether it
is editable, whether to colour its syntax, and the page's callbacks:
`onEdit`, `onChange`, `onMarkClick`, `onLayout`, and, given a toolbar,
`onComment`.

### What it does not know

Who anyone is (a mark's `by` is only a name to color), how edits merge
(the doc host's, whatever view is on), the doc host, and files.

### Cost

The parse is incremental and the preview is drawn for the lines on screen
only, so a key costs about what it costs in the plain view, whatever the
doc's length. The outline and the word count read the whole tree, a few
times a second at most. Its `limits`: 1,000,000 characters, held by `npm
run test:perf` to the B rules.

## Many writers

The host orders every edit as text operations on a revision
([Interfaces](architecture.md#interfaces)); the page turns the view's
changes into them and back (`web/client.js`), the same for both views. The
writers are the owner, teammates who can edit
([Sharing](architecture.md#sharing)), AI buddies and changes from outside.

1. **Typing out.** On each change, while no edit is on its way, the change
   goes to the host on `{ epoch, rev }` and waits as pending. Changes made
   while one is on its way go out together when the host answers it.
2. **Others in.** Pending and incoming operations are transformed against
   each other, and the result is shown with `applyText`.
3. **Cursors** are marks, as an AI buddy's is.
4. **Cmd+Z** is the editor's history, which holds only the person's own
   changes, mapped over what `applyText` put in. Its result is sent like
   typing.

Markdown adds one thing to plain text: **syntax split by a merge.** An
insert lands between `*` and `*`, in a link's URL or in a table row, and
the source parses to what neither meant. Accepted: nothing typed is lost,
the preview shows what the text now says, and people fix it by hand.

The seven cases of the many-writers prototype (#214) run against the real
host for both views (`test/collab.test.js`), with two more: the doc changed
outside, and a buddy's turn landing, while one types.
