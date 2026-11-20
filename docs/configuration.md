# Configuration

The options are no longer on one page. Every option, with its default, is now in the reference,
one page per module of the package, and how to use them for a task is in the guides. This page
keeps the headings of the old page, so that links to them still work, and each one points to its
new home. All pages are listed in the [documentation index](./README.md).

## Budget

How to set the budget for your model is now in [Costs and limits](./guides/costs-and-limits.md); every field and its default is in [`Budget`](./reference/library.md#budget).

### One library, several models

Now in [Costs and limits](./guides/costs-and-limits.md); what an adapter says about its model is [`ModelCapabilities`](./reference/ask.md#modelcapabilities).

### Limits and retries

The limits of a question are now in [Costs and limits](./guides/costs-and-limits.md) and [`AskLimits`](./reference/ask.md#asklimits); retries are in [Errors and reliability](./guides/errors-and-reliability.md) and [`RetryOptions`](./reference/errors-and-retries.md#retryoptions), and the waits on a silent model (`firstByteTimeoutMs`, `idleTimeoutMs`) are in the same guide and [`IdleWaits`](./reference/errors-and-retries.md#idlewaits).

### Room in the request

Now in [How it works](./how-it-works.md).

### How the plan is made

Now in [How it works](./how-it-works.md).

### Token estimates

Now in [How it works](./how-it-works.md).

## An explorer model

Now in [An explorer model](./guides/explorer-model.md).

### Who does what

Now in [An explorer model](./guides/explorer-model.md).

### What changes for your application

Now in [An explorer model](./guides/explorer-model.md).

### Live results with an explorer

Now in [Measurements](./measurements.md); what they mean for your setup is in [An explorer model](./guides/explorer-model.md).

## Stores

Now in [Storage](./guides/storage.md) and, for several servers, in [Deployment](./guides/deployment.md); the interface is [`DocumentStore`](./reference/library.md#documentstore).

### Large files, many users, several servers

Reading large documents by range and the cache are now in [Storage](./guides/storage.md); several servers, memory and `sweep` are in [Deployment](./guides/deployment.md).

### Keeping the uploaded file

Now in [Storage](./guides/storage.md); what `view_pages` does with the kept file is in [PDFs and other formats](./guides/pdfs.md).

## Formats

Now in [PDFs and other formats](./guides/pdfs.md).

### PDF tables

Now in [PDFs and other formats](./guides/pdfs.md).

## Pictures in PDFs

Now in [PDFs and other formats](./guides/pdfs.md).

### The line that marks a page

Now in [PDFs and other formats](./guides/pdfs.md).

### `view_pages`

Now in [PDFs and other formats](./guides/pdfs.md); the tool's arguments and limits are in [Tools](./reference/tools.md).

### Scanned PDFs

Now in [PDFs and other formats](./guides/pdfs.md).

### Live results

Now in [Measurements](./measurements.md).

### Where the pages go: `toolFilePlacement`

Now in [PDFs and other formats](./guides/pdfs.md); the option is in the [`llm-large-files/gemini`](./reference/gemini.md) and [`llm-large-files/anthropic`](./reference/anthropic.md) references.

### Your own loop

Now in [Your own adapter and loop](./guides/own-adapter-and-loop.md).

### Custom extractors

Now in [PDFs and other formats](./guides/pdfs.md); the type is [`Extractor`](./reference/library.md#extractor).
