function copyBibTeX() {
    const bibtexElement = document.getElementById("bibtex-code");
    const button        = document.querySelector(".copy-bibtex-btn");
    const copyText      = button.querySelector(".copy-text");

    if (!bibtexElement) {
        return;
    }

    navigator.clipboard.writeText(bibtexElement.textContent).then(function () {
        button.classList.add("copied");
        copyText.textContent = "Cop";

        setTimeout(function () {
            button.classList.remove("copied");
            copyText.textContent = "Copy";
        }, 2000);
    }).catch(function (err) {
        console.error("Failed to copy: ", err);
        const textArea = document.createElement("textarea");
        textArea.value = bibtexElement.textContent;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);

        button.classList.add("copied");
        copyText.textContent = "Cop";
        setTimeout(function () {
            button.classList.remove("copied");
            copyText.textContent = "Copy";
        }, 2000);
    });
}

function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: "smooth",
    });
}

window.addEventListener("scroll", function () {
    const scrollButton = document.querySelector(".scroll-to-top");

    if (!scrollButton) {
        return;
    }

    if (window.pageYOffset > 300) {
        scrollButton.classList.add("visible");
    } else {
        scrollButton.classList.remove("visible");
    }
});

(function () {
    const videos  = Array.from(document.querySelectorAll(".scene-compare-video"));
    const dots    = Array.from(document.querySelectorAll(".scene-dot"));
    const prevBtn = document.querySelector(".scene-nav--prev");
    const nextBtn = document.querySelector(".scene-nav--next");
    let current = 0;

    if (videos.length === 0 || dots.length !== videos.length || !prevBtn || !nextBtn) {
        return;
    }

    function ensureVideoLoaded(video) {
        if (video.preload !== "auto") {
            video.preload = "auto";
            video.load();
        }
    }

    function playActive(video) {
        const promise = video.play();
        if (promise && typeof promise.catch === "function") {
            promise.catch(function () {
            });
        }
    }

    function show(index) {
        const next = (index + videos.length) % videos.length;
        if (next === current) {
            playActive(videos[current]);
            return;
        }

        videos[current].classList.remove("is-active");
        dots[current].classList.remove("is-active");
        videos[current].pause();

        current = next;
        ensureVideoLoaded(videos[current]);
        videos[current].classList.add("is-active");
        dots[current].classList.add("is-active");
        playActive(videos[current]);
    }

    window.addEventListener("load", function () {
        videos.slice(1).forEach(ensureVideoLoaded);
    });

    dots.forEach(function (dot, index) {
        dot.addEventListener("click", function () {
            show(index);
        });
    });

    prevBtn.addEventListener("click", function () { show(current - 1); });
    nextBtn.addEventListener("click", function () { show(current + 1); });
    playActive(videos[current]);
})();
