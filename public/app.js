document.addEventListener('DOMContentLoaded', () => {
  setupQuestionEditor();
  setupImageUploaders();
  setupDeleteConfirmations();
  setupAttemptPage();
  setupResultPage();
});

function autoGrowField(field) {
  field.style.height = 'auto';
  field.style.height = field.scrollHeight + 'px';
}

function setupQuestionEditor() {
  const form = document.querySelector('[data-question-form]');
  const grid = document.querySelector('[data-answers-grid]');
  const button = document.querySelector('[data-add-answer-btn]');
  const questionTypeSelect = document.querySelector('[data-question-type]');

  if (!form || !grid || !button) return;

  form.querySelectorAll('[data-auto-grow]').forEach((field) => {
    autoGrowField(field);
    field.addEventListener('input', () => autoGrowField(field));
  });

  const bindAutoGrow = (field) => {
    if (!field) return;
    autoGrowField(field);
    field.addEventListener('input', () => autoGrowField(field));
  };

  const updateRemoveButtons = () => {
    const rows = [...grid.querySelectorAll('[data-answer-row]')];
    rows.forEach((row) => {
      let buttonEl = row.querySelector('[data-remove-answer-btn]');
      if (!buttonEl) {
        buttonEl = document.createElement('button');
        buttonEl.type = 'button';
        buttonEl.className = 'btn secondary answer-remove-btn';
        buttonEl.dataset.removeAnswerBtn = '1';
        buttonEl.textContent = 'Xóa đáp án';
        buttonEl.addEventListener('click', () => {
          if (grid.querySelectorAll('[data-answer-row]').length <= 2) return;
          row.remove();
          reindexRows();
          renderCorrectControls();
        });
        row.appendChild(buttonEl);
      }
      buttonEl.disabled = rows.length <= 2;
      buttonEl.classList.toggle('is-hidden', rows.length <= 2);
    });
  };

  const reindexRows = () => {
    const rows = [...grid.querySelectorAll('[data-answer-row]')];
    rows.forEach((row, index) => {
      const nextIndex = index + 1;
      row.dataset.answerIndex = String(nextIndex);

      const textarea = row.querySelector('textarea');
      if (textarea) {
        textarea.name = 'answer_' + nextIndex;
        textarea.placeholder = 'Đáp án ' + nextIndex;
      }

      const hiddenId = row.querySelector('input[type="hidden"]');
      if (hiddenId) {
        hiddenId.name = 'answer_id_' + nextIndex;
      }
    });
    updateRemoveButtons();
  };

  const renderCorrectControls = () => {
    const isMulti = questionTypeSelect && questionTypeSelect.value === 'multi';
    const rows = [...grid.querySelectorAll('[data-answer-row]')];
    const checkedValues = [...form.querySelectorAll('[name="correct_answer"]:checked')].map((input) => input.value);
    const hasCheckedValues = checkedValues.length > 0;
    const initialCorrectIndexes = rows
      .filter((row) => row.dataset.isCorrect === '1')
      .map((row) => row.dataset.answerIndex);
    const activeIndexes = hasCheckedValues ? checkedValues : initialCorrectIndexes;
    const selectedIndexes = isMulti ? activeIndexes : activeIndexes.slice(0, 1);

    rows.forEach((row) => {
      const index = row.dataset.answerIndex;
      const holder = row.querySelector('[data-correct-control]');
      if (!holder) return;
      const inputType = isMulti ? 'checkbox' : 'radio';
      const shouldCheck = selectedIndexes.includes(String(index)) || (!isMulti && !selectedIndexes.length && index === rows[0]?.dataset.answerIndex);
      holder.innerHTML =
        '<label class="inline">' +
          '<input type="' + inputType + '" name="correct_answer" value="' + index + '" ' + (shouldCheck ? 'checked' : '') + ' />' +
          'Đúng' +
        '</label>';
    });

    if (!isMulti) {
      const radios = form.querySelectorAll('[name="correct_answer"]');
      const checked = [...radios].find((input) => input.checked) || radios[0];
      if (checked) {
        radios.forEach((input) => {
          input.checked = input === checked;
        });
      }
    }
  };

  const createRow = (index) => {
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.dataset.answerRow = '1';
    row.dataset.answerIndex = String(index);
    row.dataset.isCorrect = '0';
    row.innerHTML =
      '<textarea name="answer_' + index + '" rows="2" placeholder="Đáp án ' + index + '" required data-auto-grow></textarea>' +
      '<div class="correct-control" data-correct-control></div>';
    return row;
  };

  if (questionTypeSelect) {
    questionTypeSelect.addEventListener('change', () => {
      renderCorrectControls();
    });
  }

  renderCorrectControls();
  reindexRows();

  button.addEventListener('click', () => {
    const nextIndex = grid.querySelectorAll('.answer-row').length + 1;
    const row = createRow(nextIndex);
    grid.appendChild(row);
    bindAutoGrow(row.querySelector('[data-auto-grow]'));
    reindexRows();
    renderCorrectControls();
  });
}

function setupImageUploaders() {
  const roots = document.querySelectorAll('[data-image-upload-root]');
  if (!roots.length) return;

  roots.forEach((root) => {
    const fileInput = root.querySelector('[data-image-file]');
    const uploadButton = root.querySelector('[data-image-upload-btn]');
    if (!fileInput || !uploadButton) return;

    const getTargetTextarea = () => {
      const focused = root.querySelector('textarea:focus');
      if (focused) return focused;
      const primary = root.querySelector('[data-image-target]');
      if (primary) return primary;
      return root.querySelector('textarea');
    };

    const insertAtCursor = (textarea, text) => {
      if (!textarea) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const before = textarea.value.slice(0, start);
      const after = textarea.value.slice(end);
      textarea.value = before + text + after;
      const cursor = start + text.length;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const uploadFile = async (file) => {
      if (!file) return;
      const formData = new FormData();
      formData.append('image', file);

      const response = await fetch('/uploads/image', {
        method: 'POST',
        body: formData,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || 'Upload failed');
      }

      const textarea = getTargetTextarea();
      const altText = file.name.replace(/\.[^.]+$/, '').trim() || 'Hình ảnh';
      insertAtCursor(textarea, payload.markdown || `![${altText}](${payload.url})`);
    };

    uploadButton.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      uploadButton.disabled = true;
      const originalLabel = uploadButton.textContent;
      uploadButton.textContent = 'Đang tải...';
      try {
        await uploadFile(file);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Upload failed');
      } finally {
        uploadButton.disabled = false;
        uploadButton.textContent = originalLabel;
        fileInput.value = '';
      }
    });
  });
}

function setupDeleteConfirmations() {
  const forms = document.querySelectorAll('[data-confirm-delete]');
  forms.forEach((form) => {
    form.addEventListener('submit', (event) => {
      const message = form.dataset.confirmDelete || 'Bạn có chắc chắn muốn xóa?';
      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  });

  const buttons = document.querySelectorAll('button[data-confirm-delete]');
  buttons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const message = button.dataset.confirmDelete || 'Bạn có chắc chắn muốn xóa?';
      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  });
}

function setupAttemptPage() {
  const root = document.querySelector('[data-attempt-root]');
  if (!root) return;

  const attemptId = root.dataset.attemptId;
  const form = document.getElementById('attemptForm');
  const timerEl = document.getElementById('timer');
  const totalSeconds = Number(root.dataset.remainingSeconds || 0);
  let left = totalSeconds;
  let isSubmitting = false;

  const format = (seconds) => {
    const safe = Math.max(0, seconds);
    const minutes = String(Math.floor(safe / 60)).padStart(2, '0');
    const secs = String(safe % 60).padStart(2, '0');
    return minutes + ':' + secs;
  };

  const updateSidebar = () => {
    const items = root.querySelectorAll('[data-question-id]');
    items.forEach((item) => {
      const questionId = item.dataset.questionId;
      const checked = form.querySelectorAll('[name="q_' + questionId + '"]:checked');
      const target = root.querySelector('[data-summary="' + questionId + '"] span');
      if (target) {
        target.textContent = checked.length ? checked.length + ' lựa chọn' : 'Chưa chọn';
      }
    });
  };

  const saveQuestion = async (questionId) => {
    const selected = [...form.querySelectorAll('[name="q_' + questionId + '"]:checked')].map((input) => Number(input.value));
    await fetch('/attempt/' + attemptId + '/answer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        questionId: Number(questionId),
        selectedAnswerIds: selected,
      }),
    });
  };

  const collectAnswers = () => {
    const answersByQuestion = {};
    const items = root.querySelectorAll('[data-question-id]');
    items.forEach((item) => {
      const questionId = item.dataset.questionId;
      const selected = [...form.querySelectorAll('[name="q_' + questionId + '"]:checked')].map((input) => Number(input.value));
      answersByQuestion[questionId] = selected;
    });
    return answersByQuestion;
  };

  const submitAttempt = async () => {
    if (isSubmitting) return;
    isSubmitting = true;
    try {
      const response = await fetch('/attempt/' + attemptId + '/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          answersByQuestion: collectAnswers(),
        }),
      });
      if (response.redirected) {
        window.location.href = response.url;
        return;
      }
      window.location.href = '/attempt/' + attemptId + '/result';
    } catch (error) {
      isSubmitting = false;
      form.submit();
    }
  };

  form.addEventListener('change', (event) => {
    const question = event.target.closest('[data-question-id]');
    if (!question) return;

    const isSingleChoice = question.dataset.questionType === 'single';
    if (isSingleChoice && event.target.matches('input[type="checkbox"]') && event.target.checked) {
      question.querySelectorAll('input[type="checkbox"][name="' + event.target.name + '"]').forEach((input) => {
        if (input !== event.target) {
          input.checked = false;
        }
      });
    }

    saveQuestion(question.dataset.questionId);
    updateSidebar();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAttempt();
  });

  const sidebarItems = root.querySelectorAll('[data-summary]');
  sidebarItems.forEach((item) => {
    item.addEventListener('click', () => {
      const questionId = item.dataset.summary;
      const target = root.querySelector('[data-question-id="' + questionId + '"]');
      if (!target) return;
      sidebarItems.forEach((el) => el.classList.remove('is-active'));
      item.classList.add('is-active');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('pulse-focus');
      window.setTimeout(() => target.classList.remove('pulse-focus'), 1200);
    });
  });

  const tick = () => {
    if (timerEl) {
      timerEl.textContent = format(left);
    }
    if (left <= 0) {
      submitAttempt();
      return;
    }
    left -= 1;
    window.setTimeout(tick, 1000);
  };

  updateSidebar();
  window.setTimeout(tick, 1000);
}

function setupResultPage() {
  const root = document.querySelector('[data-result-root]');
  if (!root) return;

  const filterButtons = root.querySelectorAll('[data-result-filter]');
  const questions = root.querySelectorAll('[data-result-question]');
  const emptyState = root.querySelector('[data-result-empty]');

  const applyFilter = (mode) => {
    let visibleCount = 0;
    questions.forEach((question) => {
      const isCorrect = question.dataset.isCorrect === '1';
      const shouldShow = mode === 'all' || !isCorrect;
      question.classList.toggle('is-hidden', !shouldShow);
      if (shouldShow) visibleCount += 1;
    });

    if (emptyState) {
      emptyState.classList.toggle('is-hidden', visibleCount !== 0);
    }

    filterButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.resultFilter === mode);
    });
  };

  filterButtons.forEach((button) => {
    button.addEventListener('click', () => {
      applyFilter(button.dataset.resultFilter || 'all');
    });
  });

  applyFilter('all');
}
