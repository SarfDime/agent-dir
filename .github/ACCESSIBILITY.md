# Accessibility

agent-dir is a command-line tool and MCP server. It has no graphical user interface, so accessibility here mostly concerns the terminal output, the documentation, and how you can report problems.

## What we aim for

- **Documentation** is written in plain Markdown with real headings, lists, and descriptive link text, so it works with screen readers and assistive tooling on GitHub and npm.
- **Images** in the documentation have text alternatives. Anything an image conveys is also stated in the surrounding text.
- **Terminal output** states important information (status, URLs, errors) as text labels. Color is an addition, not the only carrier of meaning.
- **The MCP interface** exchanges structured text, so any MCP client, including accessible ones, can present it in its own way.

## Known limitations

- Startup and status output uses ANSI colors and box-drawing characters. The `NO_COLOR` environment variable is not currently honored, and the box-drawing characters can be noisy in a screen reader.
- Accessibility has not been audited by an independent reviewer.

## Reporting a barrier

If something in the output or documentation is hard to use with your tools, please [open an issue](https://github.com/SarfDime/agent-dir/issues/new/choose). Describe what you were trying to do, the assistive technology or terminal you use, and what happened. Suggestions for fixes are welcome, and so are pull requests, following [CONTRIBUTING.md](CONTRIBUTING.md).

Security vulnerabilities should still be reported privately, as described in the [security policy](../docs/SECURITY.md).
