import prefixSelector from "postcss-prefix-selector";

const markdownScope = ".kmuxMarkdownSurface";
const streamdownPrefix = "kmuxsd";

export default {
  plugins: [
    prefixSelector({
      prefix: markdownScope,
      includeFiles: [
        /MarkdownSurface\.css$/u,
        /streamdown[/\\]styles\.css$/u,
        /katex[/\\]dist[/\\]katex\.min\.css$/u
      ],
      transform(prefix, selector, prefixedSelector) {
        if (selector.includes(prefix)) return selector;
        if (
          selector.includes(`${streamdownPrefix}\\:`) ||
          selector.includes(`${streamdownPrefix}:`) ||
          selector.startsWith("[data-sd-") ||
          selector.startsWith("[data-streamdown")
        ) {
          return selector;
        }
        if (/^(?::root|:host)(?:\b|\s|$)/u.test(selector)) {
          return selector;
        }
        if (/^(?:html|body)(?:\b|\s|$)/u.test(selector)) {
          return selector.replace(/^(?:html|body)/u, prefix);
        }
        return prefixedSelector;
      }
    })
  ]
};
