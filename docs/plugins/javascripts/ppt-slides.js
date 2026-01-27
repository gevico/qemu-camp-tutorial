(function () {
    "use strict";

    var SLIDE_MODE_ATTR = "data-ppt-mode";
    var SLIDE_MODE_VALUE = "slides";

    function findArticle(root) {
        if (!root || !root.querySelector) {
            return null;
        }
        return root.querySelector("article.md-content__inner");
    }

    function createToggleButton() {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "ppt-toggle";
        button.setAttribute("aria-label", "Toggle slide view");
        button.setAttribute("aria-pressed", "false");
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="13" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"></rect><path d="M8 21h8M12 16v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';
        return button;
    }

    function sanitizeClone(node) {
        var withId = node.querySelectorAll("[id]");
        withId.forEach(function (item) {
            item.removeAttribute("id");
        });
        var headerLinks = node.querySelectorAll(".headerlink");
        headerLinks.forEach(function (item) {
            item.remove();
        });
        return node;
    }

    function cloneForSlide(node) {
        var clone = node.cloneNode(true);
        return sanitizeClone(clone);
    }

    function buildSlides(article) {
        var elements = Array.prototype.slice.call(article.children);
        if (!elements.length) {
            return [];
        }

        var titleSlide = document.createElement("section");
        titleSlide.className = "ppt-slide";

        var slides = [];
        var currentSlide = null;
        var foundSection = false;
        var beforeFirstSection = true;

        elements.forEach(function (node) {
            if (node.nodeType !== 1) {
                return;
            }
            if (node.classList.contains("ppt-deck")) {
                return;
            }

            var tag = node.tagName.toLowerCase();
            if (tag === "h2") {
                foundSection = true;
                if (beforeFirstSection) {
                    slides.push(titleSlide);
                    beforeFirstSection = false;
                }
                currentSlide = document.createElement("section");
                currentSlide.className = "ppt-slide";
                currentSlide.appendChild(cloneForSlide(node));
                slides.push(currentSlide);
                return;
            }

            if (beforeFirstSection) {
                titleSlide.appendChild(cloneForSlide(node));
                return;
            }

            if (currentSlide) {
                currentSlide.appendChild(cloneForSlide(node));
            }
        });

        if (!foundSection) {
            slides = [titleSlide];
        } else if (beforeFirstSection) {
            slides.push(titleSlide);
        }

        return slides;
    }

    function createDeck(article) {
        var slides = buildSlides(article);
        if (!slides.length) {
            return null;
        }

        var deck = document.createElement("div");
        deck.className = "ppt-deck";
        deck.setAttribute("aria-hidden", "true");

        slides.forEach(function (slide) {
            deck.appendChild(slide);
        });

        var controls = document.createElement("div");
        controls.className = "ppt-controls";

        var prev = document.createElement("button");
        prev.type = "button";
        prev.className = "ppt-btn";
        prev.textContent = "Prev";

        var counter = document.createElement("span");
        counter.className = "ppt-counter";

        var next = document.createElement("button");
        next.type = "button";
        next.className = "ppt-btn";
        next.textContent = "Next";

        controls.appendChild(prev);
        controls.appendChild(counter);
        controls.appendChild(next);
        deck.appendChild(controls);

        return {
            deck: deck,
            slides: slides,
            prev: prev,
            next: next,
            counter: counter
        };
    }

    function setActiveSlide(state, index) {
        var slides = state.deckInfo.slides;
        if (!slides.length) {
            return;
        }
        var clamped = Math.max(0, Math.min(index, slides.length - 1));
        slides.forEach(function (slide, idx) {
            if (idx === clamped) {
                slide.classList.add("is-active");
            } else {
                slide.classList.remove("is-active");
            }
        });
        state.activeIndex = clamped;
        state.deckInfo.counter.textContent = String(clamped + 1) + " / " + String(slides.length);
        state.deckInfo.prev.disabled = clamped === 0;
        state.deckInfo.next.disabled = clamped === slides.length - 1;
    }

    function setMode(state, enabled) {
        state.enabled = enabled;
        if (enabled) {
            document.body.setAttribute(SLIDE_MODE_ATTR, SLIDE_MODE_VALUE);
            state.deckInfo.deck.setAttribute("aria-hidden", "false");
            setActiveSlide(state, state.activeIndex || 0);
        } else {
            document.body.removeAttribute(SLIDE_MODE_ATTR);
            state.deckInfo.deck.setAttribute("aria-hidden", "true");
        }
        state.toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    }

    function bindKeyboard() {
        if (window.__pptKeydownInit) {
            return;
        }
        window.__pptKeydownInit = true;

        document.addEventListener("keydown", function (event) {
            var state = window.__pptState;
            if (!state || !state.enabled) {
                return;
            }
            var target = event.target;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
                return;
            }
            if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
                event.preventDefault();
                setActiveSlide(state, state.activeIndex + 1);
                return;
            }
            if (event.key === "ArrowLeft" || event.key === "PageUp") {
                event.preventDefault();
                setActiveSlide(state, state.activeIndex - 1);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setMode(state, false);
            }
        });
    }

    function init(root) {
        var article = findArticle(root);
        if (!article || article.dataset.pptInit === "true") {
            return;
        }
        article.dataset.pptInit = "true";

        var title = article.querySelector("h1");
        if (!title) {
            return;
        }

        var toggle = title.querySelector(".ppt-toggle");
        if (!toggle) {
            toggle = createToggleButton();
            title.insertBefore(toggle, title.firstChild);
        }

        var deckInfo = createDeck(article);
        if (!deckInfo) {
            return;
        }
        article.appendChild(deckInfo.deck);

        var state = {
            deckInfo: deckInfo,
            toggle: toggle,
            activeIndex: 0,
            enabled: false
        };

        window.__pptState = state;

        toggle.addEventListener("click", function () {
            setMode(state, !state.enabled);
        });

        deckInfo.prev.addEventListener("click", function () {
            if (!state.enabled) {
                return;
            }
            setActiveSlide(state, state.activeIndex - 1);
        });

        deckInfo.next.addEventListener("click", function () {
            if (!state.enabled) {
                return;
            }
            setActiveSlide(state, state.activeIndex + 1);
        });

        setMode(state, false);
        bindKeyboard();
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
