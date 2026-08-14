# Lỗi: `fill_value` task không điền đủ thông tin cho figure

## Mô tả

Task `fill_value` (hoặc tương đương bước trích xuất giá trị cho từng figure) đôi khi trả về kết quả thiếu thông tin - nhiều field trống (`value = ""`, `confidence = 0`) mặc dù dữ liệu đó có thể tồn tại trong bài báo. Điều này khiến bảng giá trị của figure không đầy đủ, ảnh hưởng đến việc số hóa và phân tích sau này.

## Nguyên nhân khả dĩ

### 1. Dữ liệu parse từ paper không đúng / thiếu cho phần figure

- **Chunking cắt ngang caption hoặc nội dung quan trọng**: Thuật toán `chunkText` cắt văn bản thành các đoạn nhỏ để chạy song song. Nếu một figure caption hoặc bảng liên quan bị cắt giữa hai chunk, model chỉ thấy một nửa thông tin và không thể trích xuất đầy đủ giá trị.
- **Paragraph/sentence boundary không đúng**: Ngưỡng tìm điểm cắt (`lastBreak`) ưu tiên `\n\n` và `. ` trong 400 ký tự cuối. Nếu caption dài hoặc có định dạng bất thường (dấu chấm trong công thức, viết liền), điểm cắt có thể rơi vào giữa thông tin quan trọng.
- **Overlap không đủ**: Overlap hiện tại là 500 ký tự. Với các figure có caption > 500 ký tự hoặc nội dung rải rác, phần overlap có thể không bao phủ toàn bộ ngữ cảnh cần thiết.

### 2. `paper_text` gửi đến model bị cắt (clip)

- Task `figure_extract` clip `paperText` xuống 15.000 ký tự (`clip(paperText, 15000)`). Nếu thông tin cần thiết cho figure nằm ngoài 15k ký tự đầu tiên (ví dụ: trong phần Experimental chi tiết ở cuối bài), model không thấy và trả về empty.
- Tương tự, task `paper_context` clip 20.000 ký tự. Nếu một số characterization data nằm ngoài phạm vi này, context fallback không hoạt động được.

### 3. Model nhầm lẫn giữa các figure khác nhau

- Một bài báo có nhiều figure, model có thể "mượn" giá trị từ figure khác (cross-figure contamination). Ví dụ: thấy "pH = 4, 6, 8, 10" ở Figure 3 (nơi pH là biến thay đổi) và điền nhầm vào Figure 2 (nơi pH là cố định).
- Mặc dù prompt có cảnh báo rule 7 về cross-figure contamination, model vẫn có thể nhầm khi nhiều figure có cấu trúc tương tự.

### 4. Thứ tự prompt / cache prefix bị phá vỡ

- Nếu nội dung động (Figure JSON, Paper text) được đặt trước phần cacheable prefix, OpenAI prompt caching không match và model nhận context bị thay đổi hoặc thiếu, dẫn đến extraction kém chất lượng.

### 5. Entity identification sai trong fallback `paper_context`

- Khi field không tìm thấy trong figure text, model fallback sang `paper_context`. Nếu model không xác định đúng entity (ví dụ: nhầm catalyst A với catalyst B), nó sẽ lookup sai hoặc trả về empty vì không tìm thấy entity phù hợp.

### 6. Định dạng dữ liệu trong paper khác với schema field

- Một số trường trong paper có thể được ghi theo đơn vị khác (ví dụ: "m²/g" thay vì "m2/g"), hoặc tên field trong schema không khớp nghĩa với property trong paper (ví dụ: schema yêu cầu "SBET" nhưng paper viết "BET surface area"). Mặc dù rule 9 cho phép match by meaning, model vẫn có thể bỏ sót.

## Cách debug

1. **Kiểm tra log `[debug figure_extract]`**: Xem `paperText.length` và các term quan trọng (`BET surface area`, `pHpzc`, `2θ`) có nằm trong đoạn text gửi đến model không.
2. **Kiểm tra `chunkFailures`**: Nếu có chunk bị lỗi (deadline), một phần paper không được quét → thiếu figure hoặc thiếu thông tin.
3. **So sánh `changingFieldNames` với fields expected**: Xem model có đúng đưa các biến thay đổi vào `changingFieldNames` không, hay đã nhầm lẫn.
4. **Inspect `paperContext` sau khi build**: Đảm bảo entity được extract đúng tên và đủ properties, đặc biệt với các catalyst mới có tên phức tạp.

## Cải tiến đề xuất

1. **Tăng overlap chunk** hoặc sử dụng chunking thông minh hơn (detect figure boundaries bằng regex "Figure\s+\d+") để không cắt ngang caption.
2. **Tăng clip limit** cho `paperText` trong `figure_extract`, hoặc gửi toàn bộ paper nếu model context cho phép (hiện tại clip 15k có thể quá gắt).
3. **Thêm forced fallback**: nếu model trả empty cho field mà `paperContext` có data, tự động điền từ context thay vì tin tưởng hoàn toàn vào LLM.
4. **Chạy post-processing validation**: sau khi LLM trả về, kiểm tra xem có field nào có trong `paperContext` mà LLM bỏ sót không → retry hoặc fill tự động.
5. **Cải thiện entity disambiguation**: thêm hướng dẫn rõ ràng hơn trong prompt để model phân biệt các entity có tên tương tự.
