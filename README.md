# Hardcover for Dalibre

A metadata source and reading-status sync plugin for [Dalibre](https://github.com/djyde/dalibre) powered by [Hardcover](https://hardcover.app/). Designed to pair smoothly with [KOReader](https://koreader.rocks/)'s Hardcover sync plugin by linking matching edition ISBNs (`identifiers.isbn` + `identifiers.hardcover`).

## Features

- **Metadata lookup (`Fetch metadata` / `Look up online`):**
  - Looks up books by `hardcover` ID, `isbn` (10 or 13), or title & author search.
  - Prioritizes localized editions matching the book's language (including Brazilian Portuguese `pb` / `978-65` / `978-85` editions).
  - Imports title, authors, series & position, genres/tags, publisher, publication date, language, edition cover, synopsis, and identifiers (`hardcover`, `isbn`).
- **Two-way reading sync actions:**
  - **Tools › Sync from Hardcover…:** Matches books in your open Dalibre library against your Hardcover shelves (`Currently Reading`, `Want to Read`, `Read`, `Paused`, `Did Not Finish`), displays reading progress (`%` and page count from KOReader/Hardcover), fills missing `hardcover` IDs & edition ISBNs, imports ratings, and tags reading status non-destructively.
  - **Book menu › Set Hardcover status…:** Pushes reading status (and optional star rating) for selected Dalibre books back to Hardcover (`insert_user_book` / `update_user_book`).

## Installation & Setup

### From Dalibre

1. Open **Plugins › Install from GitHub** and enter:
   ```text
   bellussi1/dalibre-hardcover
   ```
2. Open the plugin's **Settings** and paste your Hardcover API token from [`hardcover.app/account/api`](https://hardcover.app/account/api).

### Settings

- **API token** (`apiKey`, secret, required): Personal access token from Hardcover (with or without `Bearer ` prefix).
- **Status tag prefix** (`tagPrefix`, default `"Hardcover: "`): Prefix added to Dalibre status tags (`Hardcover: Reading`, `Hardcover: Want to Read`, `Hardcover: Read`, `Hardcover: DNF`). Clear it to skip status tags.

## Development

```sh
node test.mjs
dalibre-plugin check .
dalibre-plugin identify . --isbn 9788554515263 --set apiKey="$HARDCOVER_API_KEY" --json
dalibre-plugin identify . "Artificial Condition" --author "Martha Wells" --language pt --set apiKey="$HARDCOVER_API_KEY" --json
```

## License

MIT
