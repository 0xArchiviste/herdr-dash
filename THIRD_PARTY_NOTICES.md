# Third-party notices

## herdr-projects

`internal/projects/` is a Go port of parts of
[herdr-projects](https://github.com/eliasstravik/herdr-projects) 0.2.35, the
Rust projects plugin for herdr. Taken from it: the on-disk formats of a
projects root (PROJECT.md, TASKS.md, MEMORY.md and memory/, threads/, inbox/,
routines/, .state/, .progress/, .machines.json and the user's config.toml),
the rules that read them, the thread group function, and the text of the
`list`, `overview`, `context` and `thread list` views. Each ported file names
its origin in its first line.

```
MIT License

Copyright (c) 2026 Elias Stravik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
