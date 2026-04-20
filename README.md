# Quiz Simulator

Ứng dụng giả lập thi trắc nghiệm dùng Node.js, Express, EJS và SQLite.

## Chạy ứng dụng

```bash
npm start
```

Mở trình duyệt tại:

```text
http://localhost:3000
```

## Chức năng chính

- Tạo nhiều bài thi khác nhau
- Nhập câu hỏi và 4 đáp án cho mỗi câu
- Đánh dấu 1 đáp án đúng cho mỗi câu
- Tạo bài thi thử với thời gian làm bài
- Chọn trộn câu hỏi hoặc giữ nguyên thứ tự
- Làm bài, xem lại lựa chọn bên cạnh
- Nộp bài thủ công hoặc tự nộp khi hết giờ

## Ghi chú về câu hỏi

- `One choice` là câu hỏi chỉ có 1 đáp án đúng.
- `Multi choice` là câu hỏi có nhiều đáp án đúng.
- Hệ thống sẽ chấm đúng nếu người làm chọn chính xác toàn bộ tập đáp án đúng của câu multi choice.

## Lưu ý

- Requirement hiện ghi `multi choice` nhưng đồng thời nói mỗi câu chỉ có 1 đáp án đúng.
- Mình đã triển khai theo hướng: câu hỏi có thể hiển thị dạng radio hoặc checkbox, nhưng chấm điểm vẫn theo đúng 1 đáp án đúng.
- Nếu sau này bạn muốn `multi choice` có nhiều đáp án đúng thật sự, mình có thể mở rộng schema ngay.
