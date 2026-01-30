(function () {
    var tocNavId = 0;

    function findTocRoot(root) {
        if (!root || !root.querySelector) {
            return null;
        }
        return root.querySelector(".md-sidebar--secondary [data-md-component='toc']");
    }

    function getDirectChildNav(item) {
        if (!item || !item.children) {
            return null;
        }
        for (var i = 0; i < item.children.length; i++) {
            var child = item.children[i];
            if (child && child.tagName === "NAV") {
                return child;
            }
        }
        return null;
    }

    function ensureNavId(nav) {
        if (!nav) {
            return null;
        }
        if (!nav.id) {
            tocNavId += 1;
            nav.id = "toc-nav-" + String(tocNavId);
        }
        return nav.id;
    }

    function getDirectChildToggle(item) {
        if (!item || !item.children) {
            return null;
        }
        for (var i = 0; i < item.children.length; i++) {
            var child = item.children[i];
            if (child && child.tagName === "BUTTON" && child.classList && child.classList.contains("md-toc__toggle")) {
                return child;
            }
        }
        return null;
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

    function computeActivePath(activeItem) {
        var set = new Set();
        var current = activeItem;
        while (current && current.matches && current.matches("li.md-nav__item")) {
            set.add(current);
            current = current.parentElement
                ? current.parentElement.closest("li.md-nav__item")
                : null;
        }
        return set;
    }

    function setExpandedAttr(item, expanded) {
        if (expanded) {
            item.dataset.tocExpanded = "true";
        } else {
            delete item.dataset.tocExpanded;
        }
    }

    function updateExpanded(tocRoot) {
        var activeItem = getActiveItem(tocRoot);
        var activePath = activeItem ? computeActivePath(activeItem) : new Set();

        var items = tocRoot.querySelectorAll("li.md-nav__item");
        items.forEach(function (item) {
            var childNav = getDirectChildNav(item);
            if (!childNav) {
                return;
            }

            var level = item.dataset.tocLevel;
            var userPref = item.dataset.tocUser;

            var shouldExpand = false;
            if (userPref === "expanded") {
                shouldExpand = true;
            } else if (userPref === "collapsed") {
                shouldExpand = false;
            } else if (activePath.has(item)) {
                shouldExpand = true;
            }

            setExpandedAttr(item, shouldExpand);
        });
    }

    function syncToggleState(item) {
        var btn = getDirectChildToggle(item);
        if (!btn) {
            return;
        }

        var expanded = item.dataset.tocExpanded === "true";
        btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    function ensureToggle(item, tocRoot) {
        var childNav = getDirectChildNav(item);
        if (!childNav) {
            return;
        }

        if (item.dataset.tocLevel !== "1") {
            return;
        }

        item.dataset.tocHasChildren = "true";

        if (getDirectChildToggle(item)) {
            return;
        }

        var navId = ensureNavId(childNav);

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "md-toc__toggle";
        btn.setAttribute("aria-label", "折叠/展开");
        btn.setAttribute("aria-controls", navId);

        btn.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();

            var expanded = item.dataset.tocExpanded === "true";
            item.dataset.tocUser = expanded ? "collapsed" : "expanded";
            updateExpanded(tocRoot);

            var allItems = tocRoot.querySelectorAll("li.md-nav__item[data-toc-has-children='true']");
            allItems.forEach(function (it) {
                syncToggleState(it);
            });
        });

        item.insertBefore(btn, item.firstChild);
        syncToggleState(item);
    }

    function bindTocBehavior(tocRoot) {
        if (!tocRoot || tocRoot.dataset.tocCollapseInit === "true") {
            return;
        }
        tocRoot.dataset.tocCollapseInit = "true";

        annotateLevels(tocRoot);
        updateExpanded(tocRoot);

        var items = tocRoot.querySelectorAll("li.md-nav__item");
        items.forEach(function (item) {
            ensureToggle(item, tocRoot);
        });

        items.forEach(function (item) {
            if (item.dataset.tocHasChildren === "true") {
                syncToggleState(item);
            }
        });

        var observer = new MutationObserver(function () {
            updateExpanded(tocRoot);
            var allItems = tocRoot.querySelectorAll("li.md-nav__item[data-toc-has-children='true']");
            allItems.forEach(function (item) {
                syncToggleState(item);
            });
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
