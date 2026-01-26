(function () {
    function findTocRoot(root) {
        if (!root || !root.querySelector) {
            return null;
        }
        return root.querySelector(".md-sidebar--secondary [data-md-component='toc']");
    }

    function computeTocLevel(item, tocRoot) {
        var depth = 1;
        var parent = item.parentElement;
        while (parent && parent !== tocRoot) {
            if (parent.matches("ul.md-nav__list")) {
                depth += 1;
            }
            parent = parent.parentElement;
        }
        return depth;
    }

    function annotateLevels(tocRoot) {
        var items = tocRoot.querySelectorAll("li.md-nav__item");
        items.forEach(function (item) {
            var level = computeTocLevel(item, tocRoot);
            item.dataset.tocLevel = String(level);
        });
    }

    function collapseAll(tocRoot) {
        var items = tocRoot.querySelectorAll("li.md-nav__item[data-toc-expanded]");
        items.forEach(function (item) {
            delete item.dataset.tocExpanded;
        });
    }

    function expandPath(item) {
        var current = item;
        while (current && current.matches("li.md-nav__item")) {
            current.dataset.tocExpanded = "true";
            current = current.parentElement
                ? current.parentElement.closest("li.md-nav__item")
                : null;
        }
    }

    function getActiveItem(tocRoot) {
        var activeLink = tocRoot.querySelector(".md-nav__link--active");
        if (activeLink) {
            return activeLink.closest("li.md-nav__item");
        }

        if (window.location.hash) {
            var hash = window.location.hash;
            try {
                var selector = "a.md-nav__link[href='" + CSS.escape(hash) + "']";
                var link = tocRoot.querySelector(selector);
                if (link) {
                    return link.closest("li.md-nav__item");
                }
            } catch (error) {
                return null;
            }
        }

        return null;
    }

    function updateExpanded(tocRoot) {
        collapseAll(tocRoot);
        var activeItem = getActiveItem(tocRoot);
        if (activeItem) {
            expandPath(activeItem);
        }
    }

    function bindTocBehavior(tocRoot) {
        if (!tocRoot || tocRoot.dataset.tocCollapseInit === "true") {
            return;
        }
        tocRoot.dataset.tocCollapseInit = "true";

        annotateLevels(tocRoot);
        updateExpanded(tocRoot);

        tocRoot.addEventListener("click", function (event) {
            var target = event.target;
            if (!(target instanceof Element)) {
                return;
            }
            var link = target.closest("a.md-nav__link");
            if (!link || !tocRoot.contains(link)) {
                return;
            }
            var item = link.closest("li.md-nav__item");
            if (item) {
                collapseAll(tocRoot);
                expandPath(item);
            }
        });

        var observer = new MutationObserver(function () {
            updateExpanded(tocRoot);
        });
        observer.observe(tocRoot, {
            subtree: true,
            attributes: true,
            attributeFilter: ["class"]
        });
    }

    function init(root) {
        var tocRoot = findTocRoot(root);
        if (!tocRoot) {
            return;
        }
        bindTocBehavior(tocRoot);
    }

    if (window.document$ && typeof window.document$.subscribe === "function") {
        window.document$.subscribe(function (documentRoot) {
            init(documentRoot);
        });
    } else if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            init(document);
        });
    } else {
        init(document);
    }
})();
