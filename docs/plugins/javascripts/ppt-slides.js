(function () {
    "use strict";

    var SLIDE_MODE_ATTR = "data-ppt-mode";
    var SLIDE_MODE_VALUE = "slides";
    var RESIZE_DEBOUNCE_MS = 150;
    var DRAW_COLOR = "#e53935";
    var DRAW_WIDTH = 3;
    var ERASER_WIDTH = 16;
    var HISTORY_LIMIT = 50;

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

    function getViewportHeight() {
        var header = document.querySelector(".md-header");
        var headerHeight = header ? header.offsetHeight : 0;
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        var padding = 24;
        return Math.max(360, viewportHeight - headerHeight - padding);
    }

    function scheduleFrame(callback) {
        if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(callback);
            return;
        }
        window.setTimeout(callback, 16);
    }

    function sanitizeClone(node) {
        var withId = node.querySelectorAll("[id]");
        withId.forEach(function (item) {
            item.removeAttribute("id");
        });
        var toggleButtons = node.querySelectorAll(".ppt-toggle");
        toggleButtons.forEach(function (item) {
            item.remove();
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

        elements.forEach(function (node) {
            if (node.nodeType !== 1) {
                return;
            }
            if (node.classList.contains("ppt-deck")) {
                return;
            }

            var tag = node.tagName.toLowerCase();
            if (tag === "h2" || tag === "h3") {
                if (!foundSection) {
                    if (titleSlide.children.length > 0) {
                        slides.push(titleSlide);
                    }
                    foundSection = true;
                }
                currentSlide = document.createElement("section");
                currentSlide.className = "ppt-slide";
                currentSlide.appendChild(cloneForSlide(node));
                slides.push(currentSlide);
                return;
            }

            if (!foundSection) {
                titleSlide.appendChild(cloneForSlide(node));
                return;
            }

            if (currentSlide) {
                currentSlide.appendChild(cloneForSlide(node));
            }
        });

        if (!foundSection) {
            slides = [titleSlide];
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

        var slidesContainer = document.createElement("div");
        slidesContainer.className = "ppt-slides";
        slides.forEach(function (slide) {
            slidesContainer.appendChild(slide);
        });
        deck.appendChild(slidesContainer);

        var tools = document.createElement("div");
        tools.className = "ppt-tools";

        var pointerBtn = document.createElement("button");
        pointerBtn.type = "button";
        pointerBtn.className = "ppt-tool is-active";
        pointerBtn.setAttribute("aria-label", "Pointer mode");
        pointerBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2l7 17 2-6 6 2z" fill="currentColor"></path></svg><span>Pointer</span>';

        var drawBtn = document.createElement("button");
        drawBtn.type = "button";
        drawBtn.className = "ppt-tool";
        drawBtn.setAttribute("aria-label", "Draw mode");
        drawBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.5V20h2.5l9.86-9.86-2.5-2.5L4 17.5zm14.85-8.35a.996.996 0 0 0 0-1.41l-2.59-2.59a.996.996 0 1 0-1.41 1.41l2.59 2.59c.39.39 1.02.39 1.41 0z" fill="currentColor"></path></svg><span>Draw</span>';

        var eraseBtn = document.createElement("button");
        eraseBtn.type = "button";
        eraseBtn.className = "ppt-tool";
        eraseBtn.setAttribute("aria-label", "Erase mode");
        eraseBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-9.5 9.5H6L3 14.5 16 3zm-9.5 13.5h4.17L19 8.17 15.83 5 6.5 14.33 5 12.83 16 1.83l7.17 7.17L12.17 20H6l-3-3 2.5-2.5z" fill="currentColor"></path></svg><span>Erase</span>';

        var undoBtn = document.createElement("button");
        undoBtn.type = "button";
        undoBtn.className = "ppt-tool";
        undoBtn.setAttribute("aria-label", "Undo");
        undoBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7V4L2 9l5 5v-3h7a4 4 0 1 1 0 8h-2v2h2a6 6 0 0 0 0-12H7z" fill="currentColor"></path></svg><span>Undo</span>';

        var redoBtn = document.createElement("button");
        redoBtn.type = "button";
        redoBtn.className = "ppt-tool";
        redoBtn.setAttribute("aria-label", "Redo");
        redoBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 7h-7a6 6 0 0 0 0 12h2v-2h-2a4 4 0 0 1 0-8h7v3l5-5-5-5v3z" fill="currentColor"></path></svg><span>Redo</span>';

        var clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "ppt-tool";
        clearBtn.setAttribute("aria-label", "Clear drawing");
        clearBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10l1 2h3v2H3V6h3l1-2zm2 6h2v8H9v-8zm4 0h2v8h-2v-8z" fill="currentColor"></path></svg><span>Clear</span>';

        var overlay = document.createElement("div");
        overlay.className = "ppt-overlay";

        var canvas = document.createElement("canvas");
        canvas.className = "ppt-canvas";
        canvas.setAttribute("aria-hidden", "true");

        tools.appendChild(pointerBtn);
        tools.appendChild(drawBtn);
        tools.appendChild(eraseBtn);
        tools.appendChild(undoBtn);
        tools.appendChild(redoBtn);
        tools.appendChild(clearBtn);
        overlay.appendChild(canvas);
        deck.appendChild(overlay);
        deck.appendChild(tools);

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
            slidesContainer: slidesContainer,
            slides: slides,
            overlay: overlay,
            canvas: canvas,
            pointerBtn: pointerBtn,
            drawBtn: drawBtn,
            eraseBtn: eraseBtn,
            undoBtn: undoBtn,
            redoBtn: redoBtn,
            clearBtn: clearBtn,
            prev: prev,
            next: next,
            counter: counter
        };
    }

    function updateSlideHeight(state) {
        var height = getViewportHeight();
        state.slideHeight = height;
        state.deckInfo.deck.style.setProperty("--ppt-slide-height", height + "px");
    }

    function resizeCanvas(state) {
        var rect = state.deckInfo.deck.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return;
        }
        var ratio = window.devicePixelRatio || 1;
        var snapshot = null;
        if (state.ctx) {
            snapshot = state.canvas.toDataURL();
        }
        state.canvas.width = Math.round(rect.width * ratio);
        state.canvas.height = Math.round(rect.height * ratio);
        state.canvas.style.width = rect.width + "px";
        state.canvas.style.height = rect.height + "px";
        state.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        state.ctx.lineCap = "round";
        state.ctx.lineJoin = "round";
        applyTool(state);
        if (snapshot) {
            var img = new Image();
            img.onload = function () {
                state.ctx.drawImage(img, 0, 0, rect.width, rect.height);
            };
            img.src = snapshot;
        }
    }

    function setToolActive(state, tool) {
        state.tool = tool;
        state.deckInfo.pointerBtn.classList.toggle("is-active", tool === "pointer");
        state.deckInfo.drawBtn.classList.toggle("is-active", tool === "draw");
        state.deckInfo.eraseBtn.classList.toggle("is-active", tool === "erase");
        var pointerDisabled = tool === "pointer";
        if (pointerDisabled) {
            state.isDrawing = false;
        }
        state.deckInfo.overlay.style.pointerEvents = pointerDisabled ? "none" : "auto";
        state.canvas.style.pointerEvents = pointerDisabled ? "none" : "auto";
    }

    function applyTool(state) {
        if (!state.ctx) {
            return;
        }
        if (state.tool === "erase") {
            state.ctx.globalCompositeOperation = "destination-out";
            state.ctx.strokeStyle = "rgba(0, 0, 0, 1)";
            state.ctx.lineWidth = ERASER_WIDTH;
            return;
        }
        state.ctx.globalCompositeOperation = "source-over";
        state.ctx.strokeStyle = DRAW_COLOR;
        state.ctx.lineWidth = DRAW_WIDTH;
    }

    function flashButton(state, button) {
        if (!button) {
            return;
        }
        if (state.clearFlashTimer) {
            window.clearTimeout(state.clearFlashTimer);
        }
        button.classList.remove("is-flash");
        void button.offsetWidth;
        button.classList.add("is-flash");
        state.clearFlashTimer = window.setTimeout(function () {
            button.classList.remove("is-flash");
        }, 600);
    }

    function updateHistoryButtons(state) {
        state.deckInfo.undoBtn.disabled = state.undoStack.length === 0;
        state.deckInfo.redoBtn.disabled = state.redoStack.length === 0;
    }

    function pushHistory(state, snapshot) {
        state.undoStack.push(snapshot);
        if (state.undoStack.length > HISTORY_LIMIT) {
            state.undoStack.shift();
        }
        state.redoStack.length = 0;
        updateHistoryButtons(state);
    }

    function snapshotCanvas(state) {
        if (!state.canvas) {
            return "";
        }
        return state.canvas.toDataURL("image/png");
    }

    function restoreSnapshot(state, snapshot) {
        if (!snapshot) {
            state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
            return;
        }
        var rect = state.canvas.getBoundingClientRect();
        var img = new Image();
        img.onload = function () {
            state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
            state.ctx.drawImage(img, 0, 0, rect.width, rect.height);
        };
        img.src = snapshot;
    }

    function bindDrawing(state) {
        state.ctx = state.deckInfo.canvas.getContext("2d");
        state.canvas = state.deckInfo.canvas;
        state.canvas.style.touchAction = "none";
        setToolActive(state, "pointer");
        applyTool(state);
        updateHistoryButtons(state);

        state.deckInfo.pointerBtn.addEventListener("click", function () {
            setToolActive(state, "pointer");
        });

        state.deckInfo.drawBtn.addEventListener("click", function () {
            setToolActive(state, "draw");
            applyTool(state);
        });

        state.deckInfo.eraseBtn.addEventListener("click", function () {
            setToolActive(state, "erase");
            applyTool(state);
        });

        state.deckInfo.undoBtn.addEventListener("click", function () {
            if (state.undoStack.length === 0) {
                return;
            }
            var current = snapshotCanvas(state);
            var previous = state.undoStack.pop();
            state.redoStack.push(current);
            restoreSnapshot(state, previous);
            updateHistoryButtons(state);
            flashButton(state, state.deckInfo.undoBtn);
        });

        state.deckInfo.redoBtn.addEventListener("click", function () {
            if (state.redoStack.length === 0) {
                return;
            }
            var current = snapshotCanvas(state);
            var next = state.redoStack.pop();
            state.undoStack.push(current);
            restoreSnapshot(state, next);
            updateHistoryButtons(state);
            flashButton(state, state.deckInfo.redoBtn);
        });

        state.deckInfo.clearBtn.addEventListener("click", function () {
            pushHistory(state, snapshotCanvas(state));
            state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
            flashButton(state, state.deckInfo.clearBtn);
        });

        state.canvas.addEventListener("pointerdown", function (event) {
            if (!state.enabled) {
                return;
            }
            if (state.tool === "pointer") {
                return;
            }
            state.strokeSnapshot = snapshotCanvas(state);
            state.isDrawing = true;
            applyTool(state);
            var rect = state.canvas.getBoundingClientRect();
            var x = event.clientX - rect.left;
            var y = event.clientY - rect.top;
            state.ctx.beginPath();
            state.ctx.moveTo(x, y);
            if (state.canvas.setPointerCapture) {
                state.canvas.setPointerCapture(event.pointerId);
            }
            event.preventDefault();
        });

        state.canvas.addEventListener("pointermove", function (event) {
            if (!state.enabled || !state.isDrawing || state.tool === "pointer") {
                return;
            }
            var rect = state.canvas.getBoundingClientRect();
            var x = event.clientX - rect.left;
            var y = event.clientY - rect.top;
            state.ctx.lineTo(x, y);
            state.ctx.stroke();
            event.preventDefault();
        });

        state.canvas.addEventListener("pointerup", function (event) {
            if (!state.isDrawing) {
                return;
            }
            state.isDrawing = false;
            state.ctx.closePath();
            pushHistory(state, state.strokeSnapshot || snapshotCanvas(state));
            state.strokeSnapshot = null;
            if (state.canvas.releasePointerCapture) {
                state.canvas.releasePointerCapture(event.pointerId);
            }
            event.preventDefault();
        });

        state.canvas.addEventListener("pointercancel", function () {
            state.isDrawing = false;
        });
    }

    function rebuildSlides(state) {
        var slides = buildSlides(state.article);
        state.deckInfo.slidesContainer.innerHTML = "";
        slides.forEach(function (slide) {
            state.deckInfo.slidesContainer.appendChild(slide);
        });
        state.deckInfo.slides = slides;
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
                slide.setAttribute("aria-hidden", "false");
            } else {
                slide.classList.remove("is-active");
                slide.setAttribute("aria-hidden", "true");
            }
        });
        state.activeIndex = clamped;
        state.deckInfo.counter.textContent = String(clamped + 1) + " / " + String(slides.length);
        state.deckInfo.prev.disabled = clamped === 0;
        state.deckInfo.next.disabled = clamped === slides.length - 1;
        if (state.enabled && state.tool !== "pointer") {
            setToolActive(state, "pointer");
        }
    }

    function prepareSlides(state) {
        updateSlideHeight(state);
        rebuildSlides(state);
        scheduleFrame(function () {
            resizeCanvas(state);
        });
    }

    function setMode(state, enabled) {
        state.enabled = enabled;
        if (enabled) {
            document.body.setAttribute(SLIDE_MODE_ATTR, SLIDE_MODE_VALUE);
            prepareSlides(state);
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

    function bindResize(state) {
        if (state.resizeBound) {
            return;
        }
        state.resizeBound = true;
        var timer = null;
        window.addEventListener("resize", function () {
            if (!state.enabled) {
                return;
            }
            if (timer) {
                window.clearTimeout(timer);
            }
            timer = window.setTimeout(function () {
                updateSlideHeight(state);
            }, RESIZE_DEBOUNCE_MS);
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
            article: article,
            toggle: toggle,
            activeIndex: 0,
            enabled: false,
            slideHeight: 0,
            tool: "pointer",
            isDrawing: false,
            canvas: null,
            ctx: null,
            resizeBound: false,
            clearFlashTimer: null,
            strokeSnapshot: null,
            undoStack: [],
            redoStack: []
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
        bindResize(state);
        bindDrawing(state);
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
